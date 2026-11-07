// 插件对外常量（P1 拆分：从 lib/index.js 搬出，行为不变）。
// 路由前缀、请求头、请求体上限、日志前缀都在这里，避免「常量散在入口文件里」。

export const PLUGIN = 'shop-accounts';

/** 本插件 HTTP 面的路径前缀（客户端半身里的 BASE 必须与之一致）。 */
export const BASE = '/shop-accounts';

/**
 * 只允许本插件自己的界面调用这几个路由：客户端每一个请求都带这个头。
 * 跨站请求想带自定义头就必须先过 CORS 预检，而本服务从不回 ACAO —— 预检必失败。
 * 宿主的 renderer token 门禁是第一道，这一道是插件自己的第二道（宿主策略变了也不会裸奔）。
 */
export const REQ_HEADER = 'x-dsh-shop-accounts';

/** 请求体上限：本插件最大的请求是"改配置"那几个字段，256 KB 已经是三个数量级的余量。 */
export const BODY_LIMIT = 256 * 1024;
