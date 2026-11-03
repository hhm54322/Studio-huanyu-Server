# M05：自有 WhatsApp 点击统计

范围：沿用 M02 的五种语言、公开病种、页面/按钮入口及广告来源。前端只在用户实际激活 WhatsApp 链接时上报，后端独立保存，并由管理员登录后查询；不接外部广告/分析平台，不改变患者页面排版、医院后台或报告生成流程。

## 统计口径

- 事件名固定为 `whatsapp_click`；同一次上报重试使用同一 UUID，数据库唯一键去重。用户再次点击是新的事件。
- 点击人数为所选范围内匿名浏览器标识去重数。共享设备可能合并，清除存储、更换浏览器/设备可能重新计数，不能称为实名人数。
- 匿名浏览器标识保留180天；每标签页另有会话标识。关闭浏览器存储时退化为内存标识。服务端只保存标识散列，不关联患者或专家账号。
- 不采集姓名、联系方式、病历、预填消息正文、完整URL、referrer、IP或广告点击ID作为事件字段。仅接收白名单字段；病种使用现有公开键，国家仅接受显式两字母代码。
- 点击不是实际收到消息、有效对话、预约、付费或医疗转化。本期不输出这些指标，也没有访问量分母，故不计算转化率。
- 日期默认 UTC，可指定 IANA 时区；起止日期均含当天。分组人数不能直接相加为总人数。

## 实施清单

1. 全部既有 WhatsApp 入口共用委托点击采集，不阻塞跳转，不记录悬停、普通浏览或自动程序触发。
2. 网络失败保留有界队列，最长24小时；恢复联网/再次访问时按同一事件ID重试。
3. 独立追加统计表及索引，不改历史业务数据；独立小连接池避免统计请求占用报告生成连接。
4. 公开写入接口做来源、字段、大小、时间及限流校验；管理员统计接口复用现有登录权限，禁止公开读取。
5. 提供按日期、语言、病种、页面、入口、来源、广告系列、关键词的筛选/分组分页JSON，以及服务端JSON/CSV拉取命令。

## API 与后台拉取

- `POST /api/analytics/events`：来自已配置官网 Origin 的 JSON 或 `text/plain` JSON，最大4KB；成功/重复均202。失败返回400（字段）、403（来源）、413（过大）、429（限流）或503（存储暂不可用）。不会代用户发送 WhatsApp 消息。
- `GET /api/expert/analytics/contacts`：复用现有专家工作台登录会话，**仅 admin 可查**。经官网既有 `/api/expert/` 反向代理访问，普通专家403、未登录401；返回 `private, no-store`。

查询示例：`/api/expert/analytics/contacts?from=2026-11-01&to=2026-11-30&timezone=Asia%2FShanghai&groupBy=day,campaign&locale=id`。

- `from/to`：`YYYY-MM-DD`，含首末日；默认最近30天，单次最多366天。
- `groupBy`：最多三个不重复维度，以逗号分隔；可用 `day,locale,topic,page,entry,country,source,medium,campaign,content,keyword,sourceId`。
- 可筛选 `locale,topic,page,entry,country,source,medium,campaign,content,keyword,sourceId`。省略表示不限，显式 `source=` 等空来源条件只匹配未标注流量，不把它猜测为自然流量。
- `limit` 默认50、上限100；`offset` 默认0。返回全范围 `totals`、当前页 `groups` 和 `totalGroups`；空页仍保留正确总数。
- `keyword` 来自显式投放参数 `utm_term`，未提供时为空；不从点击ID、搜索引擎账号或患者输入反查。
- `totals` 与本页分组在同一只读数据库快照内计算，含 `clicks/uniqueVisitors/sessions`。响应不提供原始标识、事件明细或病历数据。

后台可携带现有 HttpOnly 登录 cookie 请求上述接口；不新增公开统计口令，也不把管理员凭据打包进主站。

## 服务端拉取 / 导出

在后端目录使用既有数据库环境：

```sh
npm run contacts:stats -- --from 2026-11-01 --to 2026-11-30 --group-by campaign,keyword --format json
npm run contacts:stats -- --from 2026-11-01 --to 2026-11-30 --timezone Asia/Shanghai --group-by day,campaign --limit 100 --offset 0 --format csv > exports/contact-clicks.csv
```

正式构建使用 `node dist/cli/contactStats.js`，支持同名参数（`group-by/source-id` 为CLI命名）。CSV只导出当前分页，分页信息写 stderr；导出更多分组时递增 `offset`，不要把第一页误当全量。导出目录先由运维创建。服务端CLI使用主机权限和数据库配置，不能从公开页面直接执行。CSV营销字段对表格公式前缀做转义。

## 配置与发布顺序

1. 后端 `npm run db:migrate`（或 `node dist/db/migrate.js`）追加 `contact_click_events` 和三个索引；幂等执行。无需重写、关联或回填患者报告。部署前端前先完成后端迁移与路由发布。
2. `ANALYTICS_ENABLED=true`；Origin 默认为 `CORS_ORIGIN` 加官网两个域名，可用 `ANALYTICS_ALLOWED_ORIGINS` 显式收紧。需同时确认既有 CORS 允许官网 Origin。接口每个可识别来源IP每分钟120次写入；当前限流为每进程内存策略，多实例部署应在网关统一限流。
3. 前端沿用 `VITE_API_BASE_URL`，可用 `VITE_CONTACT_ANALYTICS_ENABLED=false` 暂停采集；代码不等待上报完成就打开链接。请求 `credentials:omit`、`referrerPolicy:no-referrer`，采用5秒超时及 keepalive。
4. 保持 API 与登录请求不经过静态资源缓存；统计查询由既有官网 `/api/expert/` 代理承接。不要刷新整个网站历史资源来“缓存统计”。
5. 后端迁移后核验匿名查询401、普通专家403、管理员200；再发布主站并按实际点击核验新增计数，区分测试流量。没有既有埋点的历史点击无法补算。

统计路由单独处理本机反向代理：仅当socket来源为 `127.0.0.1`、`::1` 或其IPv4映射地址时，读取 `X-Forwarded-For` 最后一项有效IP。Nginx应沿用 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` 追加真实来源；不会信任请求自行填写的首项，也不更改全局 `trustProxy`。若采集API另加CDN而未配置可信CDN的真实IP恢复，此处将按所见CDN节点限流；上线时需核实该API的实际代理链。

队列在本标签页 sessionStorage 最多20条、最长24小时，网络错误或429/503重试时保持同一事件ID；非法数据/来源或未发布接口等永久错误会丢弃该统计并保留联系功能。浏览器关闭、广告拦截、清除存储、超过队列限制等仍可能造成漏报，因此属于尽力采集，不声称100%送达。公开采集接口不能证明临床或付费行为，也不能阻止所有伪造HTTP点击。

## 本地验证

- `npm run test:analytics` 仅允许数据库名为 `huanyu_analytics_qa`，会清空该测试库内统计表并创建合成测试账号；用 `HUANYU_ENV_FILE` 指定独立测试环境，禁止指向业务库。
- 7项 PostgreSQL 集成测试、后端构建及完整迁移入口通过；覆盖并发去重、字段/来源/时间/大小校验、管理员权限、真实聚合、时区、分页、限流及本地代理转发/伪造头边界。
- 客户端生产预览14路由 × 5语言共70次实点通过；含异常恢复场景共74次点击、2个匿名浏览器、2个会话，管理员统计接口和CLI导出的JSON/CSV计数一致，7组CSV求和为74。测试未发送真实消息。
- 证据保存在本服务 `artifacts/m05/` 及客户端 `artifacts/m05-20261104/`，均不入Git。测试环境文件和会话也已确认被忽略。

状态：已随 `20261103194530` 发布并完成外网验证。线上新增独立统计表/索引及统计路由，保留现有报告与专家模块。公网五种语言的点击入库、已有管理员登录/查询、匿名查询 401 和 `no-store` 响应已核验；5 条测试事件按精确 ID 与专用来源清理。服务器端拉取使用 `node dist/cli/contactStats.js`。证据见客户端 `artifacts/deployment/20261103194530/` 及 `docs/deployment.md`。
