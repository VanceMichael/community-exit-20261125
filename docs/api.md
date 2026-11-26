# 入退驻业务 HTTP 服务说明

本服务把“企业搬走”拆成可以逐项核对的责任，而不是给企业加一个简单的“已退驻”标签。所有机构、人员、金额与文书均为合成资料，不连接真实业务系统。服务仅使用 Node.js 22 内置模块，状态以 JSON 文件原子写入（先写 `.tmp` 再 rename）。

## 角色与鉴权

请求头使用 `Authorization: Bearer <token>`。本地合成令牌来自 `fixtures/records.json` 的 actors：

| 令牌 | 角色 | 绑定自然人 | 职责边界 |
| --- | --- | --- | --- |
| `tok-operations` | operations 运营 | 无 | 核准企业身份、代表权、授权领取人；确认入驻；退驻逐项交接；转寄与核实 |
| `tok-front` | frontdesk 前台 | 无 | 只能登记来件、登记领取、门禁归还与入场尝试、查交付所需视图 |
| `tok-review` / `tok-review-2` | reviewer 争议复核 | 无 | 争议独立记录与结案，两名复核员保证不能自核自解 |
| `tok-cashier` | cashier 出纳 | 无 | 押金费用、暂扣、退款 |
| `tok-representative-a` | representative 企业代表 | PER-A | 只能访问本人仍有有效代表权的企业 |
| `tok-ops-self` | operations（兼任） | PER-A | 专门用于验证“不能自行核准本人” |

关键约束：

- 申请人不能独自核准自己的企业身份、本人代表权或本人提出的争议解除。
- 企业代表的所有请求按 `representations` 中 `active` 且在有效期内的记录限定企业范围。
- 前台的来件视图只返回交付字段（件号、收件主体、件型、封装、到达时间、时限、状态、争议/转寄标志、扫描引用），不含内部备注与事件全文；扫描面单只保存引用（`scanRef`），任何接口都不返回面单全文。

## 来件状态机

`pending`（待领取）、`verification_hold`（地址到期后的待核实）、`forwarding`（转寄安排中，现场领取关闭）、`delivered`（已领取，事实保留）、`rejected`（拒收）、`returned`（承运退回或拦截退回，不是可领取库存）、`forwarded`（已实际转寄）。

争议成立时来件带 `blocked=true`，交付暂停；普通办公服务（空间、地址）不因此停用。

## 接口清单

### 基础与审计

- `GET /health` 存活检查（无需令牌）
- `GET /source-changes` 未处理来源变更队列（运营、复核）
- `GET /audit` 审计流水（运营、复核、出纳）
- `POST /persons` 新建自然人（运营）

### 企业身份（申请与核准分离）

- `POST /company-applications` 企业身份申请（代表、运营）
- `POST /company-applications/:id/confirm` 核准，生成企业（运营；申请人本人 403）
- `POST /company-applications/:id/reject` 驳回（运营）
- `GET /companies` 企业列表（代表按范围过滤）

### 企业授权

- `POST /representations` 代表权登记，状态 `pending`
- `POST /representations/:id/verify` 运营核实后生效；同企业旧代表权变 `superseded`，旧授权领取人全部进入 `reverify`
- `POST /representations/:id/reject` 驳回
- `GET /representations?companyId=`
- `POST /recipient-auths` 授权领取人登记（仅当前有效代表），字段含 `validFrom/validUntil/scopeKinds/allowHandover`
- `POST /recipient-auths/:id/verify` 运营核实；代表权变化后须重新核实
- `POST /recipient-auths/:id/revoke` 撤销（提出代表或运营）
- `GET /recipient-auths?companyId=` 前台只返回交付资格字段

### 入驻

- `POST /tenancy-applications` 入驻申请，`services` 含 `office`/`address` 期间与签约人；签约人当日须有有效代表权
- `POST /tenancy-applications/:id/confirm` 运营确认签约主体与拟授权领取人，生成服务期间，企业转 `in_community`
- `GET /tenancy-applications`、`GET /services`

### 门禁（企业授权与个人门禁不混同）

- `POST /credentials` 发放钥匙/门禁卡，要求企业当日有有效 `office` 服务
- `POST /credentials/:id/return` 进入 `return_pending`，立即冻结新入场
- `POST /credentials/:id/return-confirm` 归还确认完成
- `POST /credentials/:id/revoke` 吊销
- `GET /credentials`
- `POST /access-attempts` 入场尝试，拒绝也落记录（返回 403 并附原因）
- `GET /access-attempts`

### 退驻（逐项交接）

- `POST /exits` 退驻申请，含 `officeEnd` 与可选 `addressEnd`（地址结束不得早于空间结束）
- `POST /exits/:id/checkpoints/space|access|address|mail|deposit` 逐项勾选；前置不满足返回 409
  - access：所有凭证须已归还/吊销
  - address：地址结束晚于空间结束时生成付费保留记录 `retentions`
  - mail：未结来件为零时才能勾选
- `GET /exits/:id/overview` 退驻总览，按空间、进出、地址、来件、争议、押金分别给出 `ended/active/open` 与具体未结对象
- `GET /exits`、`POST /exits/:id/finalize`（全部检查点完成才能结案，企业转 `exited`）

### 来件登记与领取

- `POST /mail` 前台登记，必填 `trackingNo/companyId/arrivedAt/packaging/kind`
  - 地址托管未覆盖到达日：按企业 `arrivalPolicyAfterAddress`（`reject` 直接拒收 / `verify` 进待核实）
  - `rejectOnArrival=true` 仅对 `parcel` 可拒收包裹生效；挂号通知只能登记待处理
- `POST /mail/:id/verification` 待核实件的 `accept/reject` 决定（运营）
- `POST /mail/:id/pickup` 领取登记
  - `requiresPrincipal` 件只能当前有效代表本人签收，普通代领人 403（`principal_required`）
  - 普通件可由有效代表或授权领取人领取；授权有件型范围与有效期；`allowHandover=false` 时禁止登记转交
  - 跨企业授权无效（`no_recipient_auth`），不能仅凭工位号交件
- `GET /mail`、`GET /mail/:id`（前台自动收窄视图；代表限定本企业）
- `GET /mail/pending/deadlines?atDate=` 待处理事项与紧急度，绝不自动写成已送达

### 转寄（外部承运协议）

- `POST /forwardings` 建立转寄并调用承运台；来件立即转 `forwarding`，与现场领取互斥
  - 网络异常/超时：转寄 `unclear`，原件责任保留，禁止现场领取，等待查单
  - 承运台拒绝：转寄 `carrier_rejected`，来件恢复 `pending`
- `POST /forwardings/:id/sync` 查单同步：`pending/accepted/confirmed/returned/rejected`
  - `confirmed` → 来件 `forwarded`；`returned` → 来件 `returned`
- `POST /forwardings/:id/revoke`
  - 从未成功提交（`requested`）：真正撤销，来件恢复 `pending`
  - 已提交/未明/已实际转寄后：只生成拦截申请（`intercepts`），来件不恢复可领取库存
- `POST /forwardings/:id/intercepts/:interceptId/resolve` 登记拦截结论 `intercepted/failed`
- `GET /forwardings`

### 争议复核（独立记录）

- `POST /disputes` 对未领取件提出争议，来件交付暂停
- `POST /disputes/:id/resolve` 仅 reviewer 可结案，决定 `uphold_new/uphold_old/reject`；提出人本人 403
- `GET /disputes`

### 押金

- `POST /deposits/fees` 已确认费用逐项登记（出纳、运营）
- `POST /deposits/holds` 争议暂扣，必须关联真实争议 ID，只冻结争议金额
- `POST /deposits/holds/:id/release` 释放或没收（`forfeit=true`）
- `POST /deposits/refunds` 退款；先校验金额不超过自由余额（押金−费用−暂扣−已退），再校验凭证归还
- `GET /deposits/:companyId/summary` 汇总，并始终单列未完成转寄 `openForwardingIds`——退押金不清空转寄责任

## 错误约定

统一返回 `{ "error": 中文说明, "code": 机器可读码 }`，常见码：`unauthorized`、`forbidden`、`self_approval_forbidden`、`not_found`、`state_conflict`、`principal_required`、`no_recipient_auth`、`delivery_suspended`、`forwarding_active`、`assets_unreturned`、`refund_exceeds_free_balance`、`insufficient_deposit`。

## 本地运行

```bash
npm ci --ignore-scripts
npm run build
npm test
# 终端 1：外部承运台（4317）
npm run start:partner
# 终端 2：业务服务（4318），CARRIER_URL 指向承运台
CARRIER_URL=http://127.0.0.1:4317 npm run start:app
```

环境变量：`PORT`（业务端口，默认 4318）、`APP_STATE`（业务状态文件，默认 `.local/app.json`）、`CARRIER_URL`（默认 `http://127.0.0.1:4317`）、`SEED_FILE`（播种资料，置空则从空状态开始）。
