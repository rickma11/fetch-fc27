// 云开发凭证「体检」脚本：确认这套 SecretId/SecretKey 到底属于哪个腾讯云账号、能看到哪些环境。
//
// 为什么需要它：报错 `Env Not Exists` 有三种可能 —— 环境ID写错、密钥属于别的腾讯云账号、
// 环境没关联到该腾讯云账号。只看 SDK 报错分不清，直接问腾讯云 API 最快。
//
// 用法：node scripts/tcb_whoami.js
// 凭证来源见 scripts/tcb_env.js。
const crypto = require('crypto');
const https = require('https');
const { resolve } = require('./tcb_env');

const cred = resolve();
if (cred.missing.length) {
  console.error(cred.hint);
  process.exit(1);
}

const EXPECTED_ENV = cred.ENV_ID;
// 依据云存储 fileID `cloud://<env>.<桶>-<AppId>/...` 可反推该环境归属的腾讯云账号 AppId
const EXPECTED_APPID = '1475854307';

function sha256hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function hmac(key, s) { return crypto.createHmac('sha256', key).update(s).digest(); }
function hmacHex(key, s) { return crypto.createHmac('sha256', key).update(s).digest('hex'); }

// 腾讯云 API 3.0 签名（TC3-HMAC-SHA256）
function callTencentApi(service, host, action, version, region, payloadObj) {
  const payload = JSON.stringify(payloadObj || {});
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = 'content-type:application/json; charset=utf-8\nhost:' + host + '\n';
  const signedHeaders = 'content-type;host';
  const canonicalRequest = [
    'POST', '/', '', canonicalHeaders, signedHeaders, sha256hex(payload),
  ].join('\n');
  const scope = date + '/' + service + '/tc3_request';
  const stringToSign = ['TC3-HMAC-SHA256', timestamp, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac('TC3' + cred.SECRET_KEY, date);
  const kService = hmac(kDate, service);
  const kSigning = hmac(kService, 'tc3_request');
  const signature = hmacHex(kSigning, stringToSign);
  const authorization = 'TC3-HMAC-SHA256 Credential=' + cred.SECRET_ID + '/' + scope +
    ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

  const headers = {
    Authorization: authorization,
    'Content-Type': 'application/json; charset=utf-8',
    Host: host,
    'X-TC-Action': action,
    'X-TC-Version': version,
    'X-TC-Timestamp': String(timestamp),
  };
  if (region) headers['X-TC-Region'] = region;

  return new Promise(function (resolvePromise, reject) {
    const req = https.request({ host: host, method: 'POST', path: '/', headers: headers }, function (res) {
      let body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        let json = null;
        try { json = JSON.parse(body); } catch (e) { /* 保留原文 */ }
        resolvePromise({ status: res.statusCode, json: json, raw: body });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, function () { req.destroy(new Error('请求超时')); });
    req.write(payload);
    req.end();
  });
}

function show(label, r) {
  if (r.json && r.json.Response) {
    const resp = r.json.Response;
    if (resp.Error) {
      console.log(label + ' → 失败 [' + resp.Error.Code + '] ' + resp.Error.Message);
      return null;
    }
    return resp;
  }
  console.log(label + ' → HTTP ' + r.status + ' 非预期响应: ' + String(r.raw).slice(0, 300));
  return null;
}

(async () => {
  console.log('本地配置的环境 ID:', EXPECTED_ENV);
  console.log('该环境应属账号 AppId:', EXPECTED_APPID, '（由云存储 fileID 反推）\n');

  // STS GetCallerIdentity 不依赖 tcb 权限，能直接告诉我们密钥属于哪个账号（注意必须带 Region）
  const sts = await callTencentApi('sts', 'sts.tencentcloudapi.com', 'GetCallerIdentity', '2018-08-13', 'ap-guangzhou', {});
  const stsResp = show('① 密钥归属账号', sts);
  let actualAppId = null;
  if (stsResp) {
    actualAppId = String(stsResp.AccountId || '');
    console.log('   账号 AppId = ' + actualAppId);
    console.log('   身份 Arn   = ' + (stsResp.Arn || '?'));
  }

  const REGIONS = [undefined, 'ap-shanghai', 'ap-guangzhou', 'ap-beijing', 'ap-chengdu', 'ap-nanjing', 'ap-hongkong'];
  let envIds = [];
  let envVisible = false;
  console.log('② 可见的云开发环境（逐地域探测，环境可能在非上海地域）');
  for (const rg of REGIONS) {
    const rr = await callTencentApi('tcb', 'tcb.tencentcloudapi.com', 'DescribeEnvs', '2018-06-08', rg, { Limit: 100, Offset: 0 });
    const label = rg || '(不指定)';
    if (rr.json && rr.json.Response && rr.json.Response.Error) {
      console.log('   ' + label + ' → [' + rr.json.Response.Error.Code + '] ' + rr.json.Response.Error.Message);
      continue;
    }
    const list = (rr.json && rr.json.Response && rr.json.Response.EnvList) || [];
    console.log('   ' + label + ' → ' + list.length + ' 个环境' + (list.length ? ': ' + list.map(function (e) { return e.EnvId; }).join(', ') : ''));
    if (list.length) {
      list.forEach(function (e) {
        const hit = e.EnvId === EXPECTED_ENV ? '  ← 目标环境' : '';
        console.log('        - ' + e.EnvId + ' [' + (e.Status || '?') + '] 别名 ' + (e.Alias || '-') + ' AppId ' + (e.AppId || '-') + hit);
        if (e.EnvId === EXPECTED_ENV) envVisible = true;
      });
      list.forEach(function (e) { if (envIds.indexOf(e.EnvId) < 0) envIds.push(e.EnvId); });
    }
  }

  console.log('\n③ 直查目标环境 ' + EXPECTED_ENV);
  for (const rg of ['ap-shanghai', 'ap-guangzhou', 'ap-beijing']) {
    const one = await callTencentApi('tcb', 'tcb.tencentcloudapi.com', 'DescribeEnvs', '2018-06-08', rg, { EnvId: EXPECTED_ENV });
    const resp = one.json && one.json.Response;
    if (resp && resp.Error) { console.log('   ' + rg + ' → [' + resp.Error.Code + '] ' + resp.Error.Message); continue; }
    const n = (resp && resp.EnvList) ? resp.EnvList.length : 0;
    console.log('   ' + rg + ' → 命中 ' + n + ' 个');
    if (n) { envVisible = true; console.log('        ' + JSON.stringify(resp.EnvList[0]).slice(0, 300)); }
  }

  console.log('\n==== 结论 ====');
  if (envVisible) {
    console.log('✔ 能看到目标环境。若仍报权限错，就只剩 CAM 策略没给 tcb:* 这一种可能。');
  } else if (actualAppId) {
    console.log('✘ 该密钥（账号 Uin ' + actualAppId + '）在所有地域都看不到 ' + EXPECTED_ENV + '。');
    console.log('  → 三种可能，按概率排序：');
    console.log('     1) 这个密钥不是环境归属账号下的（对照：环境存储桶后缀 AppId = ' + EXPECTED_APPID + '）');
    console.log('     2) 环境未「关联」到当前腾讯云账号（微信云开发环境需在腾讯云控制台做关联）');
    console.log('     3) 环境 ID 有误（请到微信开发者工具 → 云开发控制台核对）');
    console.log('  → 最快验证：用小程序管理员微信扫码登录腾讯云控制台，看「云开发」下能不能看到这个环境。');
  } else {
    console.log('△ 未能识别账号身份，请检查密钥是否有效。');
  }

  // 供 CI 做前置检查：看不到环境就直接失败，别浪费 6 分钟去抓取
  if (!envVisible) process.exit(2);
})().catch(function (e) {
  console.error('体检失败:', (e && e.message) || e);
  process.exit(1);
});
