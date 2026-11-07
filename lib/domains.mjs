import { catalogDomainIds, catalogDomains } from './catalog.mjs';
import { COLLECTION_DOMAINS, domainList } from './collection.mjs';

/**
 * 某平台允许的采集域（v0.12.0 目录层）：淘宝/天猫多一个「竞争洞察」，其余平台 5 域。
 * 目录不可用时 catalogDomainIds 会退回默认 5 域，行为与 v0.11.0 一致。
 */
export function allowedDomains(platformId) {
  try { return catalogDomainIds(platformId); } catch { return COLLECTION_DOMAINS.slice(); }
}

/** 某平台的域清单（带指标数），给界面/提示词用。 */
export function domainOptions(platformId) {
  try {
    const list = catalogDomains(platformId);
    return list.length ? list : domainList();
  } catch { return domainList(); }
}
