// 登录方式与平台变体（P1 拆分：从 lib/index.js 搬出，行为不变）。
// 历史数据没有这些字段 → 一律按「账号密码代填」处理。
import { normalizeAccountType, platformOf, variantOf } from './platforms.mjs';

/** 登录方式的界面文案（v0.16.6：拼多多 C 端只有验证码/扫码，密码库用不上）。 */
export function loginMethodLabel(m) {
  const k = String(m || '');
  if (k === 'password') return '账号密码';
  if (k === 'sms') return '手机验证码';
  if (k === 'qrcode') return '扫码';
  return k || '手动';
}

// ── v0.17.0：登录方式（账号密码代填 / 扫码或手动登录）─────────────────────────
// 记不住登录账号密码的用户不一定要存密码：把这家店铺改成「扫码或手动登录」，
// 打开窗口登录一次，登录态就落在这份独立的本地档案里（跟以前那套账号工具的做法一样）。
export const LOGIN_MODES = [
  { id: 'password', label: '账号密码代填' },
  { id: 'qrcode', label: '扫码或手动登录' },
];

/** 登录方式归一化：认不出来的值一律当「账号密码代填」（默认行为，与历史数据一致）。 */
export function normalizeLoginMode(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === 'qrcode' || s === 'qr' || s === 'scan' || s === 'manual') return 'qrcode';
  return 'password';
}

export function loginModeLabelOf(mode) {
  return normalizeLoginMode(mode) === 'qrcode' ? '扫码或手动登录' : '账号密码代填';
}

/** 这条店铺记录的登录方式（历史数据没有这个字段 → 账号密码代填）。 */
export function loginModeOf(account) {
  return normalizeLoginMode(account && account.loginMode);
}

/**
 * 这个店铺「实际用哪套平台参数」：平台定义 × 账号身份（卖家/买家）叠加后的变体。
 *
 * 为什么必须区分：同一平台的两个身份在登录页、工作台、cookie 域上都不一样 ——
 * 抖音卖家是抖店后台（fxg / jinritemai 域），抖音买家是抖音精选（douyin.com 域）；
 * 淘宝卖家是千牛卖家中心，买家是 havanaone 登录页 + buyertrade 已买到的宝贝。
 * 只按 `account.platform` 取平台定义会让买家身份的账号跳到卖家登录页（v0.18.1 修）。
 */
export function accountPlatformOf(account) {
  const base = platformOf(account && account.platform);
  if (!base) return null;
  const type = normalizeAccountType(account && account.accountType);
  return variantOf(base, type) || base;
}
