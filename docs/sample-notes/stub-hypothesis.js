(function (app, id) {
  // A STUBBED Hypothesis for the end-to-end test and for the screenshots. Nothing here reaches the network: the plugin's
  // http function is replaced, so no request leaves the app and no real token is used.
  var p = app.plugins.plugins[id];
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var at = function (day, h, m) { return '2026-10-' + pad(day) + 'T' + pad(h) + ':' + pad(m) + ':00.123456+00:00'; };
  var row = function (n, day, h, m, page, quote, text, tags, pos) {
    var sel = quote ? [{ type: 'TextPositionSelector', start: pos, end: pos + quote.length }, { type: 'TextQuoteSelector', exact: quote }] : [];
    return {
      id: 'stub' + n + 'abcdefgh', created: at(day, h, m), updated: at(day, h, m), user: 'acct:jane@hypothes.is',
      uri: page.uri, text: text, tags: tags, group: '__world__',
      target: [{ source: page.uri, selector: sel }], document: { title: [page.title] },
      links: { incontext: 'https://hyp.is/stub' + n + 'abcdefgh/' + page.uri.replace('https://', '') },
      hidden: false, flagged: false
    };
  };
  var pa = { uri: 'https://example.org/essays/how-to-read-a-paper', title: 'How to read a paper' };
  var pb = { uri: 'https://example.org/blog/spaced-repetition', title: 'Spaced repetition in practice' };
  var pc = { uri: 'https://example.org/notes/zettelkasten', title: 'Zettelkasten notes' };
  var st = { calls: [], mode: 'ok', userid: 'acct:jane@hypothes.is', pages: { a: pa, b: pb, c: pc } };
  st.rows = [
    row(1, 1, 9, 0, pa, 'The first pass is a quick scan to get a bird\'s-eye view of the paper.', 'Five to ten minutes.', ['reading', 'method'], 120),
    row(2, 1, 9, 10, pa, 'Read the abstract, introduction and the section headings, but ignore the details.', '', ['reading'], 480),
    row(3, 1, 9, 20, pa, '', 'Re-read the three-pass method before the seminar.', ['to-do'], null),
    row(4, 2, 18, 0, pb, 'Reviews are scheduled at growing intervals, so cards you know cost almost nothing.', 'The core idea.', ['memory'], 200),
    row(5, 2, 18, 5, pb, 'A card that you fail goes back to the shortest interval.', '', ['memory'], 900),
    row(6, 3, 7, 30, pc, 'Each note holds one idea and links to the notes that it follows from.', 'Compare with a Bases view.', ['pkm', '2026'], 60),
    row(7, 3, 7, 40, pc, '', 'Try this for the thesis notes.', [], null)
  ];
  st.addLater = function () {
    st.rows.push(row(8, 4, 8, 15, pa, 'Third pass: attempt to virtually re-implement the paper.', 'Only for papers that matter.', ['method'], 1500));
  };
  st.base = st.rows.slice();
  st.reset = async function () {
    // Back to the first run: no notes of ours, no cursor, nothing remembered as deleted.
    var s = p.service.state;
    for (var k in s.pages) { var f = app.vault.getFileByPath(s.pages[k].path); if (f) await app.vault.delete(f); }
    s.cursor = null; s.cursorUser = ''; s.pages = {}; s.deleted = []; s.lastSync = null;
    st.rows = st.base.slice();
    st.calls = []; st.mode = 'ok';
  };
  p.service.deps.client.deps.http = function (r) {
    st.calls.push({ kind: r.kind, query: r.query, auth: r.headers.Authorization, accept: r.headers.Accept });
    if (st.mode === 'offline') return Promise.resolve({ status: 0, json: null, headers: {} });
    if (st.mode === '401') return Promise.resolve({ status: 401, json: { status: 'failure', reason: 'bad token' }, headers: {} });
    if (st.mode === '429') return Promise.resolve({ status: 429, json: null, headers: { 'retry-after': '1' } });
    if (r.kind === 'profile') return Promise.resolve({ status: 200, json: { userid: st.userid }, headers: {} });
    var q = new URLSearchParams(r.query);
    var after = q.get('search_after');
    var rows = st.rows.filter(function (x) { return x.user === q.get('user') && (after === null || x.updated > after); });
    rows.sort(function (a, b) { return a.updated < b.updated ? -1 : 1; });
    rows = rows.slice(0, Number(q.get('limit')));
    return Promise.resolve({ status: 200, json: { total: rows.length, rows: rows }, headers: {} });
  };
  p.service.deps.sleep = function () { return Promise.resolve(); };
  app.secretStorage.setSecret(p.settings.tokenSecretId, 'stub-token-0000');
  p.settings.username = 'jane';
  window.__aiStub = st;
  return 'ok';
})(app, 'annotation-inbox')
