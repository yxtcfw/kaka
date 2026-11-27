# 运维与观测说明（批次 E）

## 一、缓存策略（需人工在 Cloudflare 侧配置）

`config/observability.json` 的 `cachePolicy` 记录了建议值，但**本仓库不修改 Cloudflare 账号设置**：

- HTML（`/` 与 `/*.html`）：`public, max-age=600`。当前生产环境实测即 600s；更新后最多 10 分钟生效。
- 静态资源（CSS / 图片）：`public, max-age=31536000, immutable`。**前提**是文件名带内容指纹（如 `site.a1b2c3.css`）；当前 CSS 为固定路径 `site.css`，暂不建议开长缓存，否则样式更新会被旧缓存挡住。
- 验证方法：请求头加随机参数（cache-buster）直取文件比对哈希，不要只看根路径首次响应（可能命中旧缓存）。

## 二、统计埋点（默认关闭）

`config/observability.json` 中 `enabled=false`，页面**不注入任何第三方脚本**。启用前必须人工确认：

1. 选择服务（如百度统计 / Umami 自建）；
2. 核实 `scriptSrc` 域名可信，填入 `siteId`；
3. 将 `enabled` 改为 `true`。

在确认之前不接假统计、不写假 siteId、不伪造访问数据。

## 三、图片

当前站点零图片，是有意保持的克制选择：没有真实卡面或授权 logo 时，不用占位图充数。`config/structured.json` 的 `og.image` 留空，因此不输出 og:image。若后续有真实授权图片，放入站点目录并填写 `og.image` 即可，渲染层无需改动。

## 四、URL 变更提醒

批次 A 将文章 slug 中的 `auto-` 去掉（如 `article-auto-scene` → `article-scene`），旧 URL 目前没有跳转。由于旧页面 canonical 全部指向首页、长尾基本未进索引，风险可控；如已有外链需要保留，应单独评估 301 或兼容页方案，不在本批自动处理。

## 五、外部待决清单（无法由脚本完成）

- ICP 备案号与备案主体：GitHub Pages 无备案资格，需决定托管迁移。
- 运营主体名称、营业执照、运营商授权证明：需人工核实后填入合规配置。
- 联盟推广位 `tk` 归属：需人工核验是否为本人结算渠道号。
- Bing Webmaster 报表：key 已注入但 rows=0，需核对站点 URL 与报表导出。
- 第二独立域 L2 信源：需人工补录真实独立域，不放宽门禁。
