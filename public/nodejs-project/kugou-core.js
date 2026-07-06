/**
 * @fileoverview 酷狗音乐 API 核心调用模块
 *
 * 本模块是从 KuGouMusicApi 项目中提取的独立核心层，封装了对酷狗官方 API
 * 进行调用的全部底层逻辑，包括：
 *
 * 1. 环境伪装 —— 设备标识（GUID/MID/dfid）、WebGL 指纹、平台版本号
 * 2. 签名系统 —— Android/Web/Register 三种签名算法 + signKey/signParamsKey
 * 3. 加密系统 —— AES-128-CBC、RSA（raw / PKCS1-V1_5 / OAEP）
 * 4. 请求发送 —— 自动注入设备参数、签名、User-Agent 等请求头
 * 5. 行为指纹 —— 鼠标轨迹贝塞尔曲线模拟 + AES+RSA 双层加密（sid/edt）
 * 6. 响应处理 —— SSA 二次验证检测、Cookie 解析、KRC 歌词解码
 *
 * 依赖: axios, crypto-js, node-forge, pako, big-integer
 *
 * @module kugou-core
 */

const axios = require('axios');
const CryptoJS = require('crypto-js');
const forge = require('node-forge');
const pako = require('pako');
const bigInt = require('big-integer');
const { URL } = require('url');

// ============================================================================
// 第一部分：平台配置常量
// ============================================================================

/**
 * 平台配置
 *
 * 支持两种平台模式，通过环境变量 `platform` 切换：
 * - 标准版（默认）: appid=1005, clientver=20489
 * - 概念版 lite:     appid=3116, clientver=11440
 */
const CONFIG = {
  // 微信小程序 appid / secret（用于微信登录）
  wx_appid: 'wx79f2c4418704b4f8',
  wx_lite_appid: 'wx72b795aca60ad321',
  wx_secret: '4efcab88b700769e376e3f6087b8abc9',
  wx_lite_secret: '33e486041e5e25729a4e3d2da7502f9a',

  // 来源应用 ID
  srcappid: 2919,

  // 标准版
  appid: 1005,
  apiver: 20,
  clientver: 20489,

  // 概念版 lite
  liteAppid: 3116,
  liteClientver: 11440,
};

/**
 * RSA 公钥（PEM 格式）—— 标准版
 * 用于 cryptoRSAEncrypt 函数的原始 RSA 加密
 */
const PUBLIC_RSA_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB
-----END PUBLIC KEY-----`;

/**
 * RSA 公钥（PEM 格式）—— 概念版 lite
 */
const PUBLIC_LITE_RSA_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDECi0Np2UR87scwrvTr72L6oO01rBbbBPriSDFPxr3Z5syug0O24QyQO8bg27+0+4kBzTBTBOZ/WWU0WryL1JSXRTXLgFVxtzIY41Pe7lPOgsfTCn5kZcvKhYKJesKnnJDNr5/abvTGf+rHG3YRwsCHcQ08/q6ifSioBszvb3QiwIDAQAB
-----END PUBLIC KEY-----`;

/**
 * RSA 公钥（PEM 格式）—— 行为指纹 SID 专用
 * 从酷狗 WASM 二进制中提取，用于 RSA-OAEP SHA-256 加密 AES 密钥
 * 算法: RSA-2048，公钥指数 65537 (0x10001)
 */
const SIMULATE_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoW2+Ylo8ALePSQTP0xBF
lFmEOHvBD9tS+s7DBlfKEu3RzzvZTaX1JtYbX4+AVUqj6ARz8IM+CKByqGFvbHN/
W64XxNI+q7z36ajCL3VTJ2W5G9MCJitc6oGbire4NQfhaEq0nC+hxBWQvCbIFflA
2ItrLUbSU7z1bHA/a+jlQm4OWvY+IKnTryOJTPuT1yNOVjbJ8wBLKy2DgQr9pPqW
PmEQtGpR5IM9V8Kao6PaSdKYOWGbX3i2+RzIKhvZUxxtJwdVbqPlDPlW9h4/xIBc
56Lgvr4aIl8nFtwbj4UJVUTFuGrs0tY9H/tXvZ22dUCKuGxW/gW7ZF+gXz6vHtYa
rQIDAQAB
-----END PUBLIC KEY-----`;

// ============================================================================
// 第二部分：平台判断 & UTF-8 编解码
// ============================================================================

/**
 * 判断当前是否为概念版（lite）
 * @returns {boolean}
 */
function isLite() {
  return process.env.platform === 'lite';
}

/**
 * 获取当前平台的 appid
 * @returns {number}
 */
function getAppid() {
  return isLite() ? CONFIG.liteAppid : CONFIG.appid;
}

/**
 * 获取当前平台的 clientver
 * @returns {number}
 */
function getClientver() {
  return isLite() ? CONFIG.liteClientver : CONFIG.clientver;
}

/**
 * UTF-8 编码：字符串 → Uint8Array
 */
function encodeUtf8(str) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str);
  }
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(str, 'utf8'));
  }
  const codePoints = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i++;
      }
    }
    codePoints.push(code);
  }
  const bytes = [];
  for (const code of codePoints) {
    if (code <= 0x7f) {
      bytes.push(code);
    } else if (code <= 0x7ff) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code <= 0xffff) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

/**
 * UTF-8 解码：Uint8Array → 字符串
 */
function decodeUtf8(uint8) {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(uint8);
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(uint8).toString('utf8');
  }
  let out = '';
  let i = 0;
  while (i < uint8.length) {
    const byte1 = uint8[i++];
    if (byte1 < 0x80) { out += String.fromCharCode(byte1); continue; }
    if (byte1 < 0xe0) {
      const byte2 = uint8[i++] & 0x3f;
      out += String.fromCharCode(((byte1 & 0x1f) << 6) | byte2);
      continue;
    }
    if (byte1 < 0xf0) {
      const byte2 = uint8[i++] & 0x3f;
      const byte3 = uint8[i++] & 0x3f;
      out += String.fromCharCode(((byte1 & 0x0f) << 12) | (byte2 << 6) | byte3);
      continue;
    }
    const byte2 = uint8[i++] & 0x3f;
    const byte3 = uint8[i++] & 0x3f;
    const byte4 = uint8[i++] & 0x3f;
    let codePoint = ((byte1 & 0x07) << 18) | (byte2 << 12) | (byte3 << 6) | byte4;
    codePoint -= 0x10000;
    out += String.fromCharCode((codePoint >> 10) + 0xd800, (codePoint & 0x3ff) + 0xdc00);
  }
  return out;
}

/**
 * 将任意数据规范化为 Uint8Array
 */
function normalizeBuffer(data) {
  if (data instanceof Uint8Array) return data;
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  return encodeUtf8(str);
}

/**
 * Uint8Array → CryptoJS WordArray
 */
function wordArrayFromBuffer(uint8) {
  const words = [];
  for (let i = 0; i < uint8.length; i += 4) {
    words.push(
      ((uint8[i] || 0) << 24) | ((uint8[i + 1] || 0) << 16) |
      ((uint8[i + 2] || 0) << 8) | (uint8[i + 3] || 0)
    );
  }
  return CryptoJS.lib.WordArray.create(words, uint8.length);
}

/**
 * CryptoJS WordArray → Uint8Array
 */
function wordArrayToBuffer(wordArray) {
  const { words, sigBytes } = wordArray;
  const uint8 = new Uint8Array(sigBytes);
  for (let i = 0; i < sigBytes; i++) {
    uint8[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
  }
  return uint8;
}

/**
 * Uint8Array → hex 字符串
 */
function uint8ArrayToHex(arr) {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 将字符串或 Uint8Array 转为 CryptoJS WordArray（UTF-8 编码）
 */
function utf8WordArray(input) {
  return typeof input === 'string' ? CryptoJS.enc.Utf8.parse(input) : wordArrayFromBuffer(input);
}

// ============================================================================
// 第三部分：RSA 公钥缓存与原始 RSA 加密
// ============================================================================

const rsaKeyCache = new Map();

/**
 * 从 PEM 字符串获取 forge 公钥对象（带缓存）
 */
function getForgePublicKey(pem) {
  if (!rsaKeyCache.has(pem)) {
    rsaKeyCache.set(pem, forge.pki.publicKeyFromPem(pem));
  }
  return rsaKeyCache.get(pem);
}

/**
 * Uint8Array → 二进制字符串
 */
function bufferToBinaryString(buffer) {
  let out = '';
  for (let i = 0; i < buffer.length; i++) out += String.fromCharCode(buffer[i]);
  return out;
}

/**
 * 原始 RSA 加密（无填充）
 *
 * 算法: ciphertext = message^e mod n
 * message 作为大整数解释（hex → BigInteger）
 */
function rsaRawEncrypt(buffer, publicKey) {
  const keyLength = Math.ceil(publicKey.n.bitLength() / 8);
  const message = new forge.jsbn.BigInteger(uint8ArrayToHex(buffer), 16);
  const encrypted = message.modPow(publicKey.e, publicKey.n);
  return encrypted.toString(16).padStart(keyLength * 2, '0');
}

// ============================================================================
// 第四部分：加密函数
// ============================================================================

/**
 * MD5 哈希
 * @param {string|object} data
 * @returns {string} 32位小写hex
 */
function cryptoMd5(data) {
  const buffer = typeof data === 'object' ? JSON.stringify(data) : data;
  return CryptoJS.MD5(buffer).toString(CryptoJS.enc.Hex);
}

/**
 * SHA1 哈希
 * @param {string|object} data
 * @returns {string}
 */
function cryptoSha1(data) {
  const buffer = typeof data === 'object' ? JSON.stringify(data) : data;
  return CryptoJS.SHA1(buffer).toString(CryptoJS.enc.Hex);
}

/**
 * AES-128-CBC 加密
 *
 * @param {string|object} data - 要加密的数据
 * @param {{key?:string, iv?:string}} [opt] - 可选的自定义密钥和 IV
 *   - 不传 key: 自动生成随机 key，返回 { str: hex密文, key: 密钥 }
 *   - 传入 key+iv: 返回 hex 密文字符串
 * @returns {string|{str:string, key:string}}
 */
function cryptoAesEncrypt(data, opt) {
  if (typeof data === 'object') data = JSON.stringify(data);
  const buffer = normalizeBuffer(data);
  let key;
  let iv;
  let tempKey = '';

  if (opt && opt.key && opt.iv) {
    key = opt.key;
    iv = opt.iv;
  } else {
    tempKey = (opt && opt.key) || randomString(16).toLowerCase();
    key = cryptoMd5(tempKey).substring(0, 32);
    iv = key.substring(key.length - 16);
  }

  const encrypted = CryptoJS.AES.encrypt(wordArrayFromBuffer(buffer), utf8WordArray(key), {
    iv: utf8WordArray(iv),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });

  const hex = CryptoJS.enc.Hex.stringify(encrypted.ciphertext);
  if (opt && opt.key && opt.iv) return hex;
  return { str: hex, key: tempKey };
}

/**
 * AES-128-CBC 解密
 *
 * @param {string} data - hex 密文
 * @param {string} key - 密钥
 * @param {string} [iv] - IV，不传时取 key 的 MD5 前 32 位，IV 为后 16 位
 * @returns {string|object} 解密后的明文（自动尝试 JSON.parse）
 */
function cryptoAesDecrypt(data, key, iv) {
  if (!iv) key = cryptoMd5(key).substring(0, 32);
  iv = iv || key.substring(key.length - 16);
  const cipherParams = CryptoJS.lib.CipherParams.create({ ciphertext: CryptoJS.enc.Hex.parse(data) });

  const decrypted = CryptoJS.AES.decrypt(cipherParams, utf8WordArray(key), {
    iv: utf8WordArray(iv),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });

  const text = decodeUtf8(wordArrayToBuffer(decrypted));
  try {
    return JSON.parse(text);
  } catch (e) {
    return text;
  }
}

/**
 * RSA 原始加密（无填充，用于登录参数加密）
 *
 * 自动根据平台选择公钥。
 * 数据不足 key 长度时左侧补 0。
 *
 * @param {string|object} data - 要加密的数据
 * @param {string} [publicKey] - 可选的自定义公钥 PEM
 * @returns {string} hex 密文
 */
function cryptoRSAEncrypt(data, publicKey) {
  const buffer = normalizeBuffer(data);
  const pem = publicKey || (isLite() ? PUBLIC_LITE_RSA_KEY : PUBLIC_RSA_KEY);
  const key = getForgePublicKey(pem);
  const keyLength = Math.ceil(key.n.bitLength() / 8);

  if (buffer.length > keyLength) throw new Error('Data length exceeds key size');
  let padded = buffer;
  if (buffer.length < keyLength) {
    padded = new Uint8Array(keyLength);
    padded.set(buffer);
  }

  return rsaRawEncrypt(padded, key);
}

/**
 * RSAES-PKCS1-V1_5 加密（用于 register_dev 等接口）
 *
 * 使用 forge 的标准 PKCS1 v1.5 填充方案。
 *
 * @param {string|object} data - 要加密的数据
 * @returns {string} hex 密文
 */
function rsaEncrypt2(data) {
  const buffer = normalizeBuffer(data);
  const key = getForgePublicKey(isLite() ? PUBLIC_LITE_RSA_KEY : PUBLIC_RSA_KEY);
  const encrypted = key.encrypt(bufferToBinaryString(buffer), 'RSAES-PKCS1-V1_5');
  return forge.util.bytesToHex(encrypted);
}

/**
 * 歌单/云盘数据 AES 加密
 *
 * 与标准 cryptoAesEncrypt 的区别：
 * - key 是 6 位随机字符串（非 16 位）
 * - 加密 key = MD5(key).substring(0, 16)
 * - IV = MD5(key).substring(16, 32)
 * - 输出 Base64（非 hex）
 *
 * @param {string|object} data
 * @returns {{key:string, str:string}} key=6位随机密钥, str=Base64密文
 */
function playlistAesEncrypt(data) {
  const useData = typeof data === 'object' ? JSON.stringify(data) : data;
  const key = randomString(6).toLowerCase();
  const encryptKey = cryptoMd5(key).substring(0, 16);
  const iv = cryptoMd5(key).substring(16, 32);

  const encrypted = CryptoJS.AES.encrypt(CryptoJS.enc.Utf8.parse(useData), utf8WordArray(encryptKey), {
    iv: utf8WordArray(iv),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });

  return { key, str: CryptoJS.enc.Base64.stringify(encrypted.ciphertext) };
}

/**
 * 歌单/云盘数据 AES 解密
 *
 * @param {{key:string, str:string}} data - key=6位密钥, str=Base64密文
 * @returns {string|object} 解密后的明文（自动尝试 JSON.parse）
 */
function playlistAesDecrypt(data) {
  const encryptKey = cryptoMd5(data.key).substring(0, 16);
  const iv = cryptoMd5(data.key).substring(16, 32);

  const cipherParams = CryptoJS.lib.CipherParams.create({ ciphertext: CryptoJS.enc.Base64.parse(data.str) });
  const decrypted = CryptoJS.AES.decrypt(cipherParams, utf8WordArray(encryptKey), {
    iv: utf8WordArray(iv),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });

  const text = decodeUtf8(wordArrayToBuffer(decrypted));
  try {
    return JSON.parse(text);
  } catch (e) {
    return text;
  }
}

// ============================================================================
// 第五部分：签名函数
// ============================================================================

/**
 * Web 版 API 请求 signature 签名
 *
 * 算法: MD5(盐值 + 按key排序的参数字符串(k=v格式) + 盐值)
 *
 * @param {Object} params - 请求参数键值对
 * @returns {string} 32位小写hex MD5
 */
function signatureWebParams(params) {
  const str = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
  const paramsString = Object.keys(params)
    .map((key) => `${key}=${params[key]}`)
    .sort()
    .join('');
  return cryptoMd5(`${str}${paramsString}${str}`);
}

/**
 * Android 版 API 请求 signature 签名
 *
 * 算法: MD5(盐值 + 按key排序的参数字符串(k=v格式) + 请求体 + 盐值)
 *
 * 标准版盐值: OIlwieks28dk2k092lksi2UIkp
 * 概念版盐值: LnT6xpN3khm36zse0QzvmgTZ3waWdRSA
 *
 * 注意: 当 data 为 Buffer 时，使用 CryptoJS 的增量哈希而非字符串拼接，
 * 防止二进制数据经过 UTF-8 编码导致签名错误。
 *
 * @param {Object} params - 请求参数键值对
 * @param {string|Buffer} [data] - 可选的请求体数据
 * @returns {string} 32位小写hex MD5
 */
function signatureAndroidParams(params, data) {
  const str = isLite() ? 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA' : 'OIlwieks28dk2k092lksi2UIkp';
  const paramsString = Object.keys(params)
    .sort()
    .map((key) => `${key}=${typeof params[key] === 'object' ? JSON.stringify(params[key]) : params[key]}`)
    .join('');

  if (Buffer.isBuffer(data)) {
    const hasher = CryptoJS.algo.MD5.create();
    hasher.update(CryptoJS.enc.Utf8.parse(str));
    hasher.update(CryptoJS.enc.Utf8.parse(paramsString));
    hasher.update(wordArrayFromBuffer(data));
    hasher.update(CryptoJS.enc.Utf8.parse(str));
    return hasher.finalize().toString(CryptoJS.enc.Hex);
  }

  return cryptoMd5(`${str}${paramsString}${data || ''}${str}`);
}

/**
 * 设备注册接口 signature 签名
 *
 * 算法: MD5("1014" + 按值排序的参数字符串 + "1014")
 * 注意：只取值不取 key
 *
 * @param {Object} params
 * @returns {string}
 */
function signatureRegisterParams(params) {
  const paramsString = Object.keys(params)
    .map((key) => params[key])
    .sort()
    .join('');
  return cryptoMd5(`1014${paramsString}1014`);
}

/**
 * 通用 sign 签名
 *
 * 算法: MD5(按key排序的key+value串 + 请求体 + 盐值)
 * 注意: key 和 value 之间没有等号
 *
 * @param {Object} params
 * @param {string} [data] - 可选的请求体数据
 * @returns {string}
 */
function signParams(params, data) {
  const str = 'R6snCXJgbCaj9WFRJKefTMIFp0ey6Gza';
  const paramsString = Object.keys(params)
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join('');
  return cryptoMd5(`${paramsString}${data || ''}${str}`);
}

/**
 * 请求密钥签名（signKey）
 *
 * 用于生成请求的 key 参数。
 * 算法: MD5(hash + 盐值 + appid + mid + userid)
 *
 * 标准版盐值: 57ae12eb6890223e355ccfcb74edf70d
 * 概念版盐值: 185672dd44712f60bb1736df5a377e82
 *
 * @param {string} hash - 请求哈希值
 * @param {string} mid - 设备 MID
 * @param {string|number} [userid=0] - 用户 ID
 * @param {string|number} [appid] - 应用 ID（默认使用当前平台值）
 * @returns {string}
 */
function signKey(hash, mid, userid, appid) {
  const str = isLite() ? '185672dd44712f60bb1736df5a377e82' : '57ae12eb6890223e355ccfcb74edf70d';
  return cryptoMd5(`${hash}${str}${appid || getAppid()}${mid}${userid || 0}`);
}

/**
 * 云盘接口密钥签名（signCloudKey）
 *
 * 算法: MD5("musicclound" + hash + pid + 盐值)
 *
 * @param {string} hash - 请求哈希值
 * @param {string|number} pid - 云盘资源 PID
 * @returns {string}
 */
function signCloudKey(hash, pid) {
  const str = 'ebd1ac3134c880bda6a2194537843caa0162e2e7';
  return cryptoMd5(`musicclound${hash}${pid}${str}`);
}

/**
 * 参数密钥签名（signParamsKey）
 *
 * 用于生成请求的 sign/key 参数。
 * 算法: MD5(appid + 盐值 + clientver + data)
 * 盐值同 Android 签名盐值。
 *
 * @param {string|number} data - 签名数据（通常为时间戳）
 * @param {string|number} [appid] - 应用 ID
 * @param {string|number} [clientver] - 客户端版本号
 * @returns {string}
 */
function signParamsKey(data, appid, clientver) {
  const str = isLite() ? 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA' : 'OIlwieks28dk2k092lksi2UIkp';
  appid = appid || (isLite() ? CONFIG.liteAppid : CONFIG.appid);
  clientver = clientver || (isLite() ? CONFIG.liteClientver : CONFIG.clientver);
  return cryptoMd5(`${appid}${str}${clientver}${data}`);
}

// ============================================================================
// 第六部分：工具函数
// ============================================================================

/**
 * 生成随机字符串（大写字母 + 数字）
 * @param {number} [len=16]
 * @returns {string}
 */
function randomString(len = 16) {
  const keyString = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const _key = [];
  const keyStringArr = keyString.split('');
  for (let i = 0; i < len; i += 1) {
    const ceil = Math.ceil((keyStringArr.length - 1) * Math.random());
    _key.push(keyStringArr[ceil]);
  }
  return _key.join('');
}

/**
 * 生成随机数字字符串
 * @param {number} [len=16]
 * @returns {string}
 */
function randomNumber(len = 16) {
  const keyString = '1234567890';
  const _key = [];
  const keyStringArr = keyString.split('');
  for (let i = 0; i < len; i += 1) {
    const ceil = Math.ceil((keyStringArr.length - 1) * Math.random());
    _key.push(keyStringArr[ceil]);
  }
  return _key.join('');
}

/**
 * 格式化 Cookie 字符串
 * 移除 Domain/path/expires/HttpOnly 等元数据字段
 *
 * @param {string} cookie - 原始 Set-Cookie 值
 * @returns {string} 格式化后的 key=value
 */
function parseCookieString(cookie) {
  const t = cookie.replace(/\s*(Domain|domain|path|expires)=[^(;|$)]+;*/g, '');
  return t.replace(/;HttpOnly/g, '');
}

/**
 * Cookie 字符串转 JSON 对象
 * @param {string} cookie - 如 "token=abc;userid=123"
 * @returns {Object} - 如 { token: 'abc', userid: '123' }
 */
function cookieToJson(cookie) {
  if (!cookie) return {};
  let cookieArr = cookie.split(';');
  let obj = {};
  cookieArr.forEach((i) => {
    let arr = i.split('=');
    obj[arr[0]] = arr[1];
  });
  return obj;
}

/**
 * 生成 UUID v4 格式的随机 GUID
 * 格式: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 *
 * @returns {string}
 */
function getGuid() {
  const e = () => {
    return ((65536 * (1 + Math.random())) | 0).toString(16).substring(1);
  };
  return `${e()}${e()}-${e()}-${e()}-${e()}-${e()}${e()}${e()}`;
}

/**
 * 计算设备 MID
 *
 * 算法: MD5(input) → 将 32 位 hex 视为 16 进制大整数 → 转为 10 进制字符串
 *
 * @param {string} str - 输入字符串（通常为设备 GUID）
 * @returns {string} MID 十进制字符串
 */
function calculateMid(str) {
  let bigInteger = bigInt(0);
  const bigInteger2 = bigInt(16);
  const digest = CryptoJS.MD5(str).toString(CryptoJS.enc.Hex);
  const length = digest.length;
  for (let i = 0; i < length; i += 1) {
    const charValue = bigInt(parseInt(digest.charAt(i), 16));
    const powerValue = bigInteger2.pow(length - 1 - i);
    bigInteger = bigInteger.add(charValue.multiply(powerValue));
  }
  return bigInteger.toString();
}

/**
 * 生成 WebGL 指纹哈希值
 *
 * 浏览器环境: 通过 Canvas + WebGL 渲染三角形，读取像素 + 显卡元数据，
 * 使用 FNV-1a 64-bit 哈希算法生成唯一指纹。
 *
 * Node 环境: 生成随机 uint64 作为模拟指纹。
 *
 * @returns {string} WebGL 指纹的十进制字符串
 */
function generateWebGLHash() {
  if (typeof document !== 'undefined') {
    try {
      const c = document.createElement('canvas');
      c.width = 200;
      c.height = 50;
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (gl) {
        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, 'attribute vec4 position;void main(){gl_Position=position;}');
        gl.compileShader(vs);
        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, 'void main(){gl_FragColor=vec4(1.0,1.0,1.0,1.0);}');
        gl.compileShader(fs);
        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        gl.useProgram(prog);

        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1]), gl.STATIC_DRAW);
        const pos = gl.getAttribLocation(prog, 'position');
        gl.enableVertexAttribArray(pos);
        gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
        gl.viewport(0, 0, 200, 50);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        const pixels = new Uint8Array(200 * 50 * 4);
        gl.readPixels(0, 0, 200, 50, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : '';
        const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
        const version = gl.getParameter(gl.VERSION);

        let h = BigInt('14695981039346656037');
        const prime = BigInt('1099511628211');
        for (let i = 0; i < pixels.length; i++) {
          h = ((h ^ BigInt(pixels[i])) * prime) & BigInt('0xFFFFFFFFFFFFFFFF');
        }
        const meta = vendor + '|' + renderer + '|' + version;
        for (let i = 0; i < meta.length; i++) {
          h = ((h ^ BigInt(meta.charCodeAt(i))) * prime) & BigInt('0xFFFFFFFFFFFFFFFF');
        }
        return h.toString();
      }
    } catch (e) {}
  }
  const hi = Math.floor(Math.random() * 0xffffffff);
  const lo = Math.floor(Math.random() * 0xffffffff);
  return (BigInt(hi) * BigInt(0x100000000) + BigInt(lo)).toString();
}

/**
 * KRC 歌词解码
 *
 * 流程:
 * 1. 跳过前 4 字节文件头
 * 2. 与 16 字节固定密钥进行 XOR 异或解密
 * 3. pako (zlib) 解压
 *
 * XOR 密钥: [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105]
 *
 * @param {string|Uint8Array|Buffer} val - 加密的歌词数据（字符串为 Base64）
 * @returns {string} 解码后的明文歌词
 */
function decodeLyrics(val) {
  let bytes = null;
  if (val instanceof Uint8Array) bytes = val;
  if (Buffer.isBuffer(val)) bytes = new Uint8Array(val);
  if (typeof val === 'string') bytes = new Uint8Array(Buffer.from(val, 'base64'));
  if (bytes === null) return '';

  const enKey = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];
  const krcBytes = bytes.slice(4);
  const len = krcBytes.byteLength;

  for (let index = 0; index < len; index += 1) {
    krcBytes[index] = krcBytes[index] ^ enKey[index % enKey.length];
  }

  try {
    const inflate = pako.inflate(krcBytes);
    return Buffer.from(inflate).toString('utf8');
  } catch {
    return '';
  }
}

// ============================================================================
// 第七部分：行为指纹模拟（SID / EDT 生成）
// ============================================================================

/**
 * 哨兵值（接近 0xFFFFFFFF 的随机值）
 * 每次调用 generateSimulate 时重新生成
 */
let SENTINEL = 0xffffffff - Math.floor(Math.random() * 20);

/**
 * 生成 [min, max] 范围内的随机整数（包含两端）
 */
function ri(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 三阶贝塞尔曲线鼠标路径生成
 *
 * 模拟真人鼠标轨迹特点：
 * - 有弧度和加速减速（由参数 t 均匀采样自然实现）
 * - 有微小抖动（手抖），起步时抖动大，移动后趋于稳定
 *
 * @param {number} sx - 起点 X
 * @param {number} sy - 起点 Y
 * @param {number} ex - 终点 X
 * @param {number} ey - 终点 Y
 * @param {number} n - 采样点数
 * @returns {Array<{x:number, y:number}>}
 */
function bezierPath(sx, sy, ex, ey, n) {
  const c1x = sx + (ex - sx) * 0.3 + ri(-80, 80);
  const c1y = sy + (ey - sy) * 0.2 + ri(-60, 60);
  const c2x = sx + (ex - sx) * 0.7 + ri(-60, 60);
  const c2y = sy + (ey - sy) * 0.8 + ri(-40, 40);

  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const x = u * u * u * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex;
    const y = u * u * u * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey;
    const jitter = Math.max(0.5, 3 - t * 2.5);
    pts.push({
      x: x + (Math.random() - 0.5) * jitter,
      y: y + (Math.random() - 0.5) * jitter,
    });
  }
  return pts;
}

// ---- 事件记录格式化函数 ----

function f3(t, i, x, y)  { return `3,${t},${i},${x},${y}`; }   // 鼠标移动
function f5(t, i)         { return `5,${t},${i}`; }            // 滚动/计时
function f6(t, i, x, y)   { return `6,${t},${i},${x},${y}`; }  // 窗口事件
function fs3(i, x, y)     { return `3,${SENTINEL},${i},${x},${y}`; }  // 鼠标哨兵
function fs5(i)           { return `5,${SENTINEL},${i}`; }           // 滚动哨兵
function fs6(i, x, y)     { return `6,${SENTINEL},${i},${x},${y}`; } // 窗口哨兵

/**
 * 生成 EDT 中的 data 字段（用户行为指纹数据）
 *
 * 模拟的事件序列：
 * 1. 初始化: 2 条 type-5 零事件（模拟 WASM 启动）
 * 2. 窗口事件 (type-6): 1 条，窗口尺寸 750x500
 * 3. 滚动事件 (type-5): 3 条，间隔 80-600ms 随机
 * 4. 鼠标轨迹 (type-3): 贝塞尔曲线路径，30-60 个采样点
 *    - 每 12 帧插入一次滚动事件（模拟边滚动边移动）
 * 5. 结束事件: 最后一次鼠标位置微调
 *
 * 各条目用冒号 `:` 分隔，每个条目的字段用逗号 `,` 分隔。
 * 每条常规事件后跟前一条哨兵记录（时间戳字段 = SENTINEL）。
 *
 * @param {{startX,startY,endX,endY,mousePoints}} opts
 * @returns {string} 编码后的 data 字段字符串
 */
function generateEDTData(opts) {
  const { startX, startY, endX, endY, mousePoints } = opts;
  const entries = [];
  let ts = 0;
  let ei = 0;

  // 初始化
  entries.push(f5(0, 0)); entries.push(fs5(0));
  entries.push(f5(0, 0)); entries.push(fs5(0));

  // 窗口事件
  ts += ri(5, 20);
  entries.push(f6(ts, ei, 750, 500));
  entries.push(fs6(ei, 750, 500));
  ei++;

  // 滚动事件 x3
  for (let i = 0; i < 3; i++) {
    ts += ri(80, 600);
    entries.push(f5(ts, ei));
    entries.push(fs5(ei));
    ei++;
  }

  // 鼠标轨迹
  const path = bezierPath(startX, startY, endX, endY, mousePoints);
  let si = 0;
  for (let i = 0; i < path.length; i++) {
    const { x, y } = path[i];
    ts += ri(8, 50);
    entries.push(f3(ts, si, Math.round(x), Math.round(y)));
    entries.push(fs3(si, Math.round(x), Math.round(y)));
    if (i > 0 && i % 12 === 0) {
      ts += ri(20, 60);
      entries.push(f5(ts, ei));
      entries.push(fs5(ei));
      ei++;
    }
    si = (si + 1) % 2;
  }

  // 结束事件
  ts += ri(5, 30);
  entries.push(f3(ts, 1, Math.round(endX + ri(-5, 5)), Math.round(endY + ri(-5, 5))));
  entries.push(fs3(1, Math.round(endX), Math.round(endY)));

  return entries.join(':');
}

/**
 * 生成模拟的 sid 和 edt 加密数据
 *
 * 完整流程：
 * 1. 生成随机 AES-128 密钥（16 字节，取随机字符串 MD5 的前 16 字符）
 * 2. 随机化鼠标轨迹参数
 * 3. 生成模拟行为数据
 * 4. 拼接完整明文: mid=xxx;userid=xxx;dfid=xxx;webgl=xxx;webdriver=0;ts=xxx;data=xxx
 * 5. AES-128-CBC 加密明文 → EDT（Base64）
 *    - IV: "kugousecurity123"
 * 6. RSA-OAEP SHA-256 加密 AES 密钥 → SID（Base64）
 *
 * @param {string|number} mid - 设备 MID
 * @param {string|number} userid - 用户 ID
 * @param {string|number} dfid - 设备指纹 ID
 * @param {string} [webglHash] - WebGL 指纹哈希
 * @returns {{edt:string, sid:string}}
 */
function generateSimulate(mid, userid, dfid, webglHash) {
  SENTINEL = 0xffffffff - Math.floor(Math.random() * 20);

  const key = CryptoJS.MD5(randomString(16)).toString(CryptoJS.enc.Hex).substring(0, 16);

  const points = ri(30, 60);
  const startX = ri(200, 600);
  const startY = ri(200, 500);
  const endX = ri(500, 700);
  const endY = ri(80, 150);

  mid = mid || 0;
  userid = userid || 0;
  dfid = dfid || 0;
  webglHash = webglHash || generateWebGLHash();
  const ts = Date.now();

  const data = generateEDTData({ startX, startY, endX, endY, mousePoints: points });
  const sidPlaintext = `mid=${mid};userid=${userid};dfid=${dfid};webgl=${webglHash};webdriver=0;ts=${ts};data=${data}`;

  // AES-128-CBC 加密行为数据 → EDT
  const edtData = CryptoJS.AES.encrypt(sidPlaintext, CryptoJS.enc.Utf8.parse(key), {
    iv: CryptoJS.enc.Utf8.parse('kugousecurity123'),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  }).toString();

  // RSA-OAEP SHA-256 加密 AES 密钥 → SID
  const rsaKey = forge.pki.publicKeyFromPem(SIMULATE_RSA_PUBLIC_KEY);
  const encrypted = rsaKey.encrypt(key, 'RSA-OAEP', {
    md: forge.md.sha256.create(),
    mgf1: { md: forge.md.sha256.create() },
  });
  const ciphertext = forge.util.encode64(encrypted);

  return { edt: edtData, sid: ciphertext };
}

// ============================================================================
// 第八部分：代理配置解析
// ============================================================================

let cachedProxyRaw;
let cachedProxy;

/**
 * 解析代理配置
 *
 * 从环境变量 KUGOU_API_PROXY 读取代理地址，解析为 axios 兼容格式。
 * 支持: http://user:pass@host:port
 *
 * @returns {import('axios').AxiosProxyConfig|null}
 */
function resolveProxy() {
  const rawProxyEnv = typeof process.env.KUGOU_API_PROXY === 'string' ? process.env.KUGOU_API_PROXY.trim() : undefined;
  const rawProxy = rawProxyEnv && rawProxyEnv.length > 0 ? rawProxyEnv : undefined;

  if (!rawProxy) { cachedProxyRaw = undefined; cachedProxy = null; return null; }
  if (cachedProxyRaw === rawProxy) return cachedProxy;

  cachedProxyRaw = rawProxy;
  try {
    const parsed = new URL(rawProxy);
    if (!/^https?:$/.test(parsed.protocol)) {
      cachedProxy = null;
      return null;
    }
    const proxyConfig = {
      protocol: parsed.protocol.replace(':', ''),
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80,
    };
    if (parsed.username || parsed.password) {
      proxyConfig.auth = { username: parsed.username, password: parsed.password };
    }
    cachedProxy = proxyConfig;
  } catch (error) {
    cachedProxy = null;
  }
  return cachedProxy;
}

// ============================================================================
// 第九部分：核心请求函数 —— createRequest
// ============================================================================

/**
 * 创建并发送酷狗 API 请求（核心函数）
 *
 * 完整流程：
 * 1. 从 cookie 提取设备标识（dfid、mid、uuid、token、userid、webglHash）
 * 2. 构建默认参数（dfid、mid、uuid、appid、clientver、clienttime）
 * 3. 构建请求头（User-Agent、设备信息、IP 透传）
 * 4. 根据 encryptType 生成签名
 * 5. 配置代理
 * 6. 发送 HTTP 请求并处理响应
 * 7. 检测 SSA 二次验证，自动生成 sid/edt 行为指纹
 *
 * @param {Object} options - 请求配置
 * @param {'get'|'GET'|'post'|'POST'} options.method - HTTP 方法
 * @param {string} options.url - 请求路径
 * @param {string} [options.baseURL] - 基础 URL（默认 "https://gateway.kugou.com"）
 * @param {Object} [options.params] - URL 查询参数
 * @param {Object|Buffer} [options.data] - 请求体
 * @param {Object} [options.headers] - 自定义请求头
 * @param {'android'|'web'|'register'} [options.encryptType='android'] - 签名类型
 * @param {Object} options.cookie - Cookie 对象（至少含 KUGOU_API_MID）
 * @param {boolean} [options.encryptKey] - 是否生成 signKey
 * @param {boolean} [options.clearDefaultParams] - 是否清除自动注入的默认参数
 * @param {boolean} [options.notSignature] - 是否跳过签名
 * @param {string} [options.ip] - 客户端 IP（用于 IP 透传）
 * @param {string} [options.realIP] - 真实 IP（优先级高于 ip）
 * @param {string} [options.responseType] - 响应类型（如 'arraybuffer'）
 * @returns {Promise<{status:number, body:any, cookie:string[], headers:Object}>}
 */
function createRequest(options) {
  return new Promise(async (resolve, reject) => {
    // ---- 从 Cookie 提取设备标识 ----
    const dfid = options && options.cookie && options.cookie.dfid ? options.cookie.dfid : '-';
    const mid = `${(options && options.cookie && options.cookie.KUGOU_API_MID) || ''}`;
    const uuid = '-';
    const token = (options && options.cookie && options.cookie.token) || '';
    const userid = (options && options.cookie && options.cookie.userid) || 0;
    const clienttime = Math.floor(Date.now() / 1000);
    const ip = (options && options.realIP) || (options && options.ip) || '';
    const webglHash = options && options.cookie && options.cookie.KUGOU_API_WEBGL;

    // ---- 请求头 ----
    const headers = {
      dfid, clienttime, mid,
      'kg-rc': '1',
      'kg-thash': '5d816a0',
      'kg-rec': 1,
      'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
    };
    // IP 透传
    if (ip) {
      headers['X-Real-IP'] = ip;
      headers['X-Forwarded-For'] = ip;
    }

    // ---- 默认参数 ----
    const defaultParams = {
      dfid,
      mid,
      uuid,
      appid: isLite() ? CONFIG.liteAppid : CONFIG.appid,
      clientver: isLite() ? CONFIG.liteClientver : CONFIG.clientver,
      clienttime,
    };
    if (token) defaultParams['token'] = token;
    if (userid && userid !== 0) defaultParams['userid'] = userid;

    const params = (options && options.clearDefaultParams)
      ? (options.params || {})
      : Object.assign({}, defaultParams, (options && options.params) || {});

    headers['clienttime'] = params.clienttime;

    // ---- signKey ----
    if (options && options.encryptKey) {
      params['key'] = signKey(params['hash'], params['mid'], params['userid'], params['appid']);
    }

    // ---- 序列化请求体 ----
    const data = Buffer.isBuffer(options && options.data)
      ? options.data
      : typeof (options && options.data) === 'object'
        ? JSON.stringify(options.data)
        : (options && options.data) || '';

    // ---- 生成签名 ----
    if (!params['signature'] && !(options && options.notSignature)) {
      switch (options && options.encryptType) {
        case 'register':
          params['signature'] = signatureRegisterParams(params);
          break;
        case 'web':
          params['signature'] = signatureWebParams(params);
          break;
        case 'android':
        default:
          params['signature'] = signatureAndroidParams(params, data);
          break;
      }
    }

    // ---- 构建请求选项 ----
    const requestOptions = {
      method: options && options.method,
      baseURL: (options && options.baseURL) || 'https://gateway.kugou.com',
      url: options && options.url,
      params,
      data: (options && options.data) || undefined,
      headers: Object.assign(
        { 'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi' },
        (options && options.headers) || {},
        { dfid, clienttime: params.clienttime, mid },
        headers
      ),
      withCredentials: true,
      responseType: options && options.responseType,
    };

    // ---- 代理 ----
    const proxyConfig = resolveProxy();
    if (proxyConfig) {
      requestOptions.proxy = proxyConfig;
    }

    // ---- CDN 接口特殊处理 ----
    if ((options && options.baseURL && options.baseURL.includes('openapicdn')) ||
        (options && options.baseURL && options.baseURL.includes('trackercdn'))) {
      const _params = Object.keys(params)
        .map((key) => `${key}=${params[key]}`)
        .join('&');
      requestOptions.url = `${requestOptions.url}?${_params}`;
      requestOptions.params = {};
    }

    // ---- 发送请求 ----
    const answer = { status: 500, body: {}, cookie: [], headers: {} };
    try {
      const response = await axios(requestOptions);

      let ssaCode = '';
      const body = response.data;

      // 解析 Set-Cookie
      answer.cookie = (response.headers['set-cookie'] || []).map((x) => parseCookieString(x));

      // SSA 验证码检测
      if (response.headers['ssa-code'] || response.headers['SSA-CODE']) {
        const _ssaCode = response.headers['ssa-code'] || response.headers['SSA-CODE'];
        answer.headers['ssa-code'] = _ssaCode;
        ssaCode = _ssaCode;
      }

      // 解析响应体
      try {
        answer.body = JSON.parse(body.toString());
      } catch (error) {
        answer.body = body;
      }

      // 响应状态判断
      if (response.data.status === 0 || (response.data && response.data.error_code && response.data.error_code !== 0)) {
        // 失败
        answer.status = 502;
        if (ssaCode) {
          const { edt, sid } = generateSimulate(mid, userid, dfid, webglHash);
          if (edt) answer.body.edt = edt;
          if (sid) answer.body.sid = sid;
          answer.body.ssaCode = ssaCode;
        }
        reject(answer);
      } else {
        // 成功
        answer.status = 200;
        if (ssaCode) {
          const { edt, sid } = generateSimulate(mid, userid, dfid, webglHash);
          if (edt) answer.body.edt = edt;
          if (sid) answer.body.sid = sid;
          answer.body.ssaCode = ssaCode;
        }
        resolve(answer);
      }
    } catch (e) {
      // 网络错误
      answer.status = 502;
      answer.body = { status: 0, msg: e };
      reject(answer);
    }
  });
}

// ============================================================================
// 导出
// ============================================================================

module.exports = {
  // --- 配置 ---
  CONFIG,
  isLite,
  getAppid,
  getClientver,

  // --- 加密 ---
  cryptoMd5,
  cryptoSha1,
  cryptoAesEncrypt,
  cryptoAesDecrypt,
  cryptoRSAEncrypt,
  rsaEncrypt2,
  playlistAesEncrypt,
  playlistAesDecrypt,

  // --- 签名 ---
  signatureWebParams,
  signatureAndroidParams,
  signatureRegisterParams,
  signParams,
  signKey,
  signCloudKey,
  signParamsKey,

  // --- 工具 ---
  randomString,
  randomNumber,
  parseCookieString,
  cookieToJson,
  getGuid,
  calculateMid,
  generateWebGLHash,
  decodeLyrics,

  // --- 行为指纹 ---
  generateSimulate,

  // --- 请求 ---
  createRequest,

  // --- RSA 公钥 ---
  PUBLIC_RSA_KEY,
  PUBLIC_LITE_RSA_KEY,
  SIMULATE_RSA_PUBLIC_KEY,
};
