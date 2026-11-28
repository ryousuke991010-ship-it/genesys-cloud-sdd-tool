/* データの保存先: GitHubリポジトリ(api.github.comをモック)とPCのフォルダ(OPFSで代用) */
const { launch, seedConnected, assert } = require('./helpers');

exports.name = 'データの保存先(GitHub・フォルダ)';

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const unb64 = s => Buffer.from(s, 'base64').toString('utf8');

exports.run = async () => {
  const { page, url, errors, close } = await launch();
  try {
    // --- GitHubのモック(リポジトリ内の sdd-projects/ にファイルを持つ) ---
    const files = {
      'sdd-projects/prj_remote.json': JSON.stringify({ format: 'gc-sdd-project', version: 1, project: { id: 'prj_remote', name: '別PCで作った業務', phase: 'design', updatedAt: 1000, messages: [], specVersions: [], builds: [], testCases: [], evaluations: [] } })
    };
    const commits = [];
    let authOk = true;
    await page.route('https://api.github.com/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const p = decodeURIComponent(u.pathname);
      const json = (j, status = 200) => route.fulfill({ status, json: j });
      if (req.headers().authorization !== 'Bearer github_pat_test' || !authOk) return json({ message: 'Bad credentials' }, 401);
      if (p === '/repos/me/designs') return json({ full_name: 'me/designs', private: true, permissions: { push: true } });
      if (p === '/repos/me/designs/branches/main') return json({ name: 'main' });
      const m = p.match(/^\/repos\/me\/designs\/contents\/(.+)$/);
      if (!m) return json({ message: 'nf' }, 404);
      const path = m[1];
      if (req.method() === 'GET') {
        if (path === 'sdd-projects') return json(Object.keys(files).filter(f => f.startsWith('sdd-projects/')).map(f => ({ type: 'file', name: f.split('/')[1], path: f, sha: `sha-${files[f].length}` })));
        if (!(path in files)) return json({ message: 'Not Found' }, 404);
        if (req.headers().accept.includes('raw')) return route.fulfill({ status: 200, body: files[path] });
        return json({ sha: `sha-${files[path].length}`, content: b64(files[path]) });
      }
      const body = JSON.parse(req.postData());
      if (req.method() === 'PUT') {
        if (path in files && body.sha !== `sha-${files[path].length}`) return json({ message: 'sha mismatch' }, 409);
        files[path] = unb64(body.content);
        commits.push(body.message);
        return json({ content: { sha: 'x' } });
      }
      if (req.method() === 'DELETE') { delete files[path]; commits.push(body.message); return json({}); }
      return json({}, 405);
    });

    await seedConnected(page, url);
    await page.waitForSelector('.hero');
    assert((await page.textContent('.setup-list')).includes('おすすめ: GitHub'), 'ホームで保存先(GitHub)をすすめる');

    // 手元にプロジェクトを1つ作っておく
    await page.click('[data-act="new"]');
    await page.fill('form [name="name"]', '手元の業務');
    await page.click('form button[type="submit"]');
    await page.waitForSelector('#chatInput');

    // 設定: GitHubを選ぶ → 接続確認 → 切り替え
    await page.click('#settingsBtn');
    await page.waitForSelector('#storageCard');
    const firstOption = await page.textContent('.storage-option');
    assert(firstOption.includes('GitHub') && firstOption.includes('おすすめ'), 'GitHubが先頭でおすすめ');
    await page.check('[name="storageMode"][value="github"]');
    await page.fill('[name="ghOwner"]', 'me');
    await page.fill('[name="ghRepo"]', 'designs');
    await page.fill('[name="ghToken"]', 'github_pat_test');
    assert(await page.$eval('#storageApply', b => b.disabled), '接続確認の前は切り替えられない');
    await page.click('#ghCheck');
    await page.waitForSelector('#ghResult .success');
    await page.click('#storageApply');
    await page.click('.modal [data-act="ok"]');
    await page.waitForSelector('text=件を取り込み');
    assert((await page.textContent('#nav')).includes('別PCで作った業務'), '保存先のプロジェクトを取り込む');
    const localFile = Object.entries(files).find(([, t]) => t.includes('手元の業務'));
    assert(localFile && JSON.parse(localFile[1]).format === 'gc-sdd-project', '手元のプロジェクトを書き出す');
    assert(!localFile[1].includes('sk-ant-test'), 'APIキーは書き出さない');
    assert((await page.textContent('#syncPill')).includes('GitHub'), '上部に保存先を表示');

    // 変更 → 少し待つと自動でコミット(上部のボタンで今すぐ保存も可)
    const before = commits.length;
    await page.click('#newProjectBtn');
    await page.fill('form [name="name"]', '追加した業務');
    await page.click('form button[type="submit"]');
    await page.waitForSelector('#chatInput');
    await page.click('#syncPill');
    await page.waitForFunction(() => document.querySelector('#syncPill').textContent.includes('✓'));
    assert(commits.length > before && Object.values(files).some(t => t.includes('追加した業務')), '変更をコミット');

    // ブラウザのデータを消しても、保存先から戻る
    await page.evaluate(() => new Promise(r => { const q = indexedDB.deleteDatabase('gc_sdd_v1'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
    await page.goto(url);
    await page.reload();
    await page.waitForSelector('#nav .nav-item');
    const nav = await page.textContent('#nav');
    assert(nav.includes('追加した業務') && nav.includes('別PCで作った業務'), `保存先から復元: ${nav}`);

    // トークンが無効になったら上部に警告
    authOk = false;
    await page.click('#nav >> text=追加した業務');
    await page.click('#deletePrj');
    await page.fill('.modal input', '追加した業務');
    await page.click('.modal [data-act="ok"]');
    await page.click('#syncPill');
    await page.waitForFunction(() => document.querySelector('#syncPill').textContent.includes('⚠'));
    authOk = true;
    await page.click('#syncPill');
    await page.waitForFunction(() => document.querySelector('#syncPill').textContent.includes('✓'));
    assert(!Object.values(files).some(t => t.includes('追加した業務')), '削除も保存先に反映(履歴には残る)');

    // --- PCのフォルダ(ブラウザ内の非公開ファイルシステムで代用) ---
    await page.evaluate(() => { window.showDirectoryPicker = async () => navigator.storage.getDirectory(); });
    await page.click('#settingsBtn');
    await page.waitForSelector('#storageCard');
    await page.evaluate(() => { window.showDirectoryPicker = async () => navigator.storage.getDirectory(); });
    await page.check('[name="storageMode"][value="folder"]');
    await page.click('#pickFolder');
    await page.waitForFunction(() => !document.querySelector('#storageApply').disabled);
    await page.click('#storageApply');
    await page.click('.modal [data-act="ok"]');
    await page.waitForSelector('text=件を取り込み');
    const names = await page.evaluate(async () => {
      const dir = await navigator.storage.getDirectory();
      const out = [];
      for await (const [name, h] of dir.entries()) out.push(`${name}:${(await (await h.getFile()).text()).includes('手元の業務')}`);
      return out;
    });
    assert(names.some(n => n.endsWith(':true')), `フォルダに書き出す: ${names}`);

    // GitHubの「ファイルがまだ無い(404)」と、わざと無効にしたトークン(401)はブラウザが通信エラーとして記録するので除く
    assert(!errors.filter(e => !/status of (404|401)/.test(e)).length, `コンソールエラー: ${errors.join(' | ')}`);
  } finally {
    await close();
  }
};
