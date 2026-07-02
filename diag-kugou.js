/**
 * 酷狗集成诊断脚本
 * 运行: node diag-kugou.js
 *
 * 检查:
 * 1. kugou-core.js 是否可以加载
 * 2. 已保存的登录状态
 * 3. 搜索API (如果已登录)
 * 4. 歌单API (如果已登录)
 * 5. 歌曲URL API (如果已登录)
 */
const kugou = require('./kugou-core.js');
const fs = require('fs');
const path = require('path');

const COOKIE_FILE = path.join(__dirname, '.kg-cookie');
const PLATFORM_FILE = path.join(__dirname, '.kg-platform');

async function safeReq(config, fallback) {
  try { return await kugou.createRequest(config); }
  catch(e) { return fallback || { body: {}, _error: e.body?.error_code || e.message }; }
}

(async () => {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   酷狗集成诊断 v1                      ║');
  console.log('╚══════════════════════════════════════╝\n');

  // 1. 模块检查
  console.log('[1] kugou-core 模块');
  console.log('    加载: OK (' + Object.keys(kugou).length + ' exports)');
  console.log('    平台: ' + (kugou.isLite() ? '概念版 lite' : '标准版'));
  console.log('    appid: ' + kugou.getAppid() + ' clientver: ' + kugou.getClientver());

  // 2. 平台持久化
  if (fs.existsSync(PLATFORM_FILE)) {
    console.log('    平台文件: ' + fs.readFileSync(PLATFORM_FILE, 'utf8').trim());
  } else {
    console.log('    平台文件: 不存在（首次运行）');
  }

  // 3. Cookie 检查
  console.log('\n[2] 登录状态');
  if (fs.existsSync(COOKIE_FILE)) {
    const cookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
    const token = cookie.match(/token=([^;]+)/);
    const userid = cookie.match(/userid=([^;]+)/);
    console.log('    cookie文件: 存在 (' + cookie.length + ' bytes)');
    console.log('    token: ' + (token ? token[1].substring(0, 16) + '...' : '无'));
    console.log('    userid: ' + (userid ? userid[1] : '无'));
  } else {
    console.log('    cookie文件: 不存在 -> 未登录');
    console.log('\n    请先登录！运行以下步骤:');
    console.log('    1. cd 到本项目目录');
    console.log('    2. node -e "');
    console.log('      const k=require(\'./kugou-core.js\');');
    console.log('      (async()=>{');
    console.log('        const r=await k.createRequest({');
    console.log('          baseURL:\'https://login-user.kugou.com\',url:\'/v2/qrcode\',method:\'GET\',');
    console.log('          params:{appid:1001,type:1,plat:4,srcappid:2919,qrcode_txt:\'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=1005&\'},');
    console.log('          encryptType:\'web\',cookie:{KUGOU_API_MID:k.calculateMid(k.getGuid()),KUGOU_API_GUID:k.getGuid()}');
    console.log('        });');
    console.log('        const key=r.body.data.qrcode;');
    console.log('        console.log(\'用酷狗APP打开:\',\'https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=\'+key);');
    console.log('        // 扫码后在酷狗APP确认，然后等5秒再手动保存cookie');
    console.log('      })();"');
    console.log('    3. 记录 token 和 userid，手动保存:');
    console.log('       node -e "require(\'fs\').writeFileSync(\'.kg-cookie\',\'token=xxx;userid=yyy\')"');
    console.log('    4. 重新运行 node diag-kugou.js');
    process.exit(0);
  }

  // 4. API 测试
  const cookieStr = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
  const cookieObj = {};
  cookieStr.split(';').forEach(p => { const eq = p.indexOf('='); if (eq > 0) cookieObj[p.slice(0, eq).trim()] = p.slice(eq + 1).trim(); });
  cookieObj.KUGOU_API_GUID = kugou.getGuid();
  cookieObj.KUGOU_API_MID = kugou.calculateMid(cookieObj.KUGOU_API_GUID);
  cookieObj.dfid = kugou.randomString(24);

  console.log('\n[3] 搜索 API');
  const s = await safeReq({
    url: '/v3/search/song', method: 'GET',
    params: { keyword: '海阔天空', page: 1, pagesize: 5, platform: 'AndroidFilter' },
    encryptType: 'android', cookie: cookieObj, headers: { 'x-router': 'complexsearch.kugou.com' },
  }, { body: {} });
  const songs = (s.body?.data?.lists) || [];
  if (s._error) { console.log('    失败: error_code=' + s._error); }
  else if (songs.length) { console.log('    成功: ' + songs.length + ' 首'); songs.slice(0, 3).forEach(x => console.log('      - ' + (x.SongName || x.songname || '?') + ' / ' + (x.SingerName || x.singername || '?'))); }
  else { console.log('    返回空列表 (可能 token 过期)'); }

  console.log('\n[4] 歌曲 URL');
  if (songs[0]) {
    const u = await safeReq({
      url: '/v5/url', method: 'GET', encryptType: 'android', encryptKey: true, notSign: true,
      params: { hash: songs[0].hash || songs[0].Hash, album_id: 0, quality: '320', behavior: 'play', pid: 2, cmd: 26, pidversion: 3001, area_code: 1, ssa_flag: 'is_fromtrack', version: 11430, page_id: 151369488, ppage_id: '463467626,350369493,788954147', cdnBackup: 1, module: '', clientver: 11430, IsFreePart: 0 },
      cookie: Object.assign({}, cookieObj, { dfid: kugou.randomString(24) }),
      headers: { 'x-router': 'trackercdn.kugou.com' },
    }, { body: {} });
    const uData = u.body?.data || {};
    if (u._error) { console.log('    失败: ' + u._error); }
    else if (uData.url) { console.log('    成功: ' + (Array.isArray(uData.url) ? uData.url[0].substring(0, 60) : uData.url.substring(0, 60))); }
    else { console.log('    返回空 URL (可能需要 VIP)'); }
  }

  console.log('\n[5] 用户歌单');
  const p = await safeReq({
    url: '/v1/user/playlist', method: 'GET',
    params: { page: 1, pagesize: 10 },
    encryptType: 'android', cookie: cookieObj, headers: { 'x-router': 'pubsongs.kugou.com' },
  }, { body: {} });
  const pls = (p.body?.data?.list) || (p.body?.data?.info) || [];
  if (p._error) { console.log('    失败: ' + p._error); }
  else if (pls.length) { console.log('    成功: ' + pls.length + ' 个歌单'); pls.slice(0, 5).forEach(x => console.log('      - ' + (x.name || x.special_name || '?') + ' (' + (x.count || x.track_count || 0) + '首)')); }
  else { console.log('    返回空列表'); }

  console.log('\n[6] 综合判断');
  if (s._error === 152) console.log('    搜索 error_code=152 → Token 无效或已过期，请重新登录');
  else if (songs.length && !p._error) console.log('    一切正常！IPC 层应能正常工作。如前端仍异常，请检查:');
  else console.log('    部分功能异常，查看上述输出定位问题');

  console.log('\n══════════════════════════════════════');
})();
