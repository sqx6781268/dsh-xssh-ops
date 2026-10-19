# 上游 issue 建议：支持经 SOCKS5 代理连接服务器

> 用途：本文件是一份可直接粘贴到 GitHub 的 issue 草稿（正文即 issue 内容）。
> 目标仓库：`caoyiwei850/dsh-xssh-ops`
> 调研时间：2026-10-14　调研基线：上游 `main`（v0.3.20）
> 说明：文中所有 `文件:行号` 均在本仓库 v0.3.20 源码上逐一 grep 复核；实测数据来自真实代理探测，未做任何推测性补全。

---

## 标题（建议直接使用）

```
feat: 支持经 SOCKS5 代理连接服务器（当前只能提供代理，不能使用代理）
```

---

## 一、背景 / 现状

插件目前有两种"上游"能力，但**都不能满足"经 SOCKS5 代理连服务器"这一需求**，因为它们的语义方向都不对。

### 1.1 跳板机 ProxyJump：上游必须是"能登录的 SSH 服务器"

`connectChain()`（`src/index.js:1076`）逐跳建立 ssh2 连接：每一跳 `new Client()`（`src/index.js:1116`），`hopConnectConfig` 从 `src/index.js:1081` 起组装，必须带 `username`（`src/index.js:1084`）与认证材料（`src/index.js:1093`–`src/index.js:1103`），再靠 `forwardOut`（`src/index.js:1151`）把流串到下一跳或最终目标。

也就是说，跳板机是**一台需要账号、需要认证、需要主机指纹校验的 SSH 服务器**。而 SOCKS5 代理（尤其免认证的内网代理）不需要账号，也不该走 SSH 握手与 TOFU 流程——两者是不同的东西，跳板机无法替代代理。

### 1.2 动态 SOCKS5 隧道：插件实现的是**服务端**，方向相反

`src/socks5.js` 是一个 SOCKS5 **服务端**实现（文件头注释见 `src/socks5.js:1`–`src/socks5.js:11`，入口 `attachSocks5()` 在 `src/socks5.js:91`），由 `tunnelStartDynamic()`（`src/index.js:4001`）挂到本机监听端口上（`attachSocks5` 调用点 `src/index.js:4016`）。它的作用是**把本机端口变成代理出口，对外提供代理**（`ssh -D` 语义）。

**结论一句话**：插件会「提供」SOCKS5 代理，不会「使用」SOCKS5 代理。全仓 `src/` 下没有任何 SOCKS5 **客户端**实现，也没有任何地方在拨号时读取"上游代理"配置。

### 1.3 现有三处拨号点（这是"能不能用上代理"的全部关键）

| # | 位置 | 现状 | 不处理会怎样 |
| --- | --- | --- | --- |
| 1 | `connectClient()`　`src/index.js:865` | 仅当 `record.proxyJump.length > 0` 时注入 `sock`（`src/index.js:875`–`src/index.js:879`）；否则 `sock = undefined`，交给 ssh2 自己直连。最终 `config.sock = sock`（`src/index.js:952`） | 主路径完全不知道代理的存在 |
| 2 | `openRepairedSock()`　`src/index.js:1045` | 对端 SSH 横幅不合规、`bannerRepair` 触发时，若上游没给 sock 就**自己** `net.createConnection({ host, port })` 直连（`src/index.js:1049`） | **banner 修复路径会绕过代理**，出现"配了代理却偶尔直连"的隐蔽故障 |
| 3 | `connectChain()`　`src/index.js:1076` | 第 1 跳直连（`hopConnectConfig` 不带 `sock`） | 「代理 + 跳板机」组合下，第 1 跳仍会走直连，代理形同虚设 |

三处必须同时改，缺一处就会出现"配置生效与否取决于对端横幅是否合规"这类极难排查的行为。

---

## 二、需求场景

目标服务器**只能经 SOCKS5 代理可达**，典型场景：

- 目标在内网/隔离区，只有代理机一个入口（代理机本身不是可登录的 SSH 服务器，或不愿在代理机上留账号）；
- 网络出口统一收敛到一台 SOCKS5 代理（堡垒/审计/穿透网关），要求所有 SSH 流量经其转发；
- 端口转发式代理（见下）只暴露"代理机本地端口"，用于把内网服务映射出来，客户端无法直连目标地址。

当前只能退化成"先在别处手工起一条隧道再连本机端口"，既脱离插件的资源管理，也丢失了终端/SFTP/端口转发/数据库的整条链路。

---

## 三、实测证据（2026-10-14，真实代理探测）

### 3.1 两个代理端口行为完全不同

| 代理 | 类型 | 目标地址怎么填 | 实测结果 |
| --- | --- | --- | --- |
| `192.168.10.4:1080` | **标准 SOCKS5**（RFC 1928） | 填**真实目标地址** | 免认证；`CONNECT 192.168.10.11:22` → 收到 banner `SSH-2.0-OpenSSH_7.4`，与**直连同一目标的 banner 逐字节一致** |
| `192.168.10.4:18092` | **端口转发式**（目标地址被忽略，只认代理机本地端口） | 必须填 **`127.0.0.1`** | `CONNECT 127.0.0.1:3306` → 收到 MySQL `5.5.50` 握手；`CONNECT` **任何其他主机**（含 `192.168.10.11`）→ 回 `rep=0`「成功」但**0 字节静默关闭** |

> `18092` 这一条必须写进实现与文档：它**不是** bug，而是转发型代理的正常语义——客户端把资源声明的 `host:port` 原样发出去即可，用户填 `127.0.0.1` 就按 `127.0.0.1` 走。这也解释了为什么第一次探测看起来"CONNECT 成功却什么都收不到"。

### 3.2 方法协商的坑（`18092` 实测，各轮结果稳定）

| 客户端在 greeting 里提供的方法 | 代理回应 | 含义 |
| --- | --- | --- |
| 仅 no-auth `0x00` | `05 00` | 接受免认证 |
| 仅 user/pass `0x02` | `05 02` | 要求用户名/密码认证 |
| **两者都提供** | **`05 02`** | **优先选择认证（02）** |

**由此得出一条硬性实现约束**：客户端**必须"有凭据才声明 `0x02`"**。如果无脑把 `0x00` 和 `0x02` 一起发出去，这类代理会直接要求认证，导致**本可免认证的连接失败**。

### 3.3 复现方式

对 `192.168.10.4:1080` 与 `192.168.10.4:18092` 各做一次原始 TCP 探测即可复现：发 greeting（`05 01 00`，或按上表分别只发 `00` / 只发 `02` / 两个都发），读方法回复；再发 `CONNECT`（atyp=1 的 IPv4 或 atyp=3 的域名）到上表所列目标，比对返回的 banner 字节与 `rep` 码。两个端口的差异与上表完全一致。

---

## 四、建议实现方案

### 4.1 新增 `src/socks5-client.js`（与现有服务端对称）

把编解码纯函数与网络分离，便于单测（对齐 `src/socks5.js` 的既有风格）：

| 导出 | 作用 |
| --- | --- |
| `buildGreeting(hasCredentials)` | 方法协商：**只有确实配了用户名/密码时才带 `0x02`** |
| `parseMethodReply(buf)` | 解析 `05 xx`，识别 `0xFF`（无可用方法）与 `0x02`（要求认证） |
| `buildUserPassAuth(user, pass)` | RFC 1929 认证子协商 |
| `buildConnectRequest(host, port)` | 按 IPv4 / IPv6 / **域名** 分别编码 |
| `parseConnectReply(buf)` | 解析 `rep` 码并映射为可读原因 |
| `socks5Connect({ proxy, target, timeoutMs })` | 返回一个已就绪的 socket；失败抛带 `code` 的错误 |

### 4.2 三处拨号点同时接线（缺一不可）

改造后 `connectClient` 的拨号优先级：

```
1. 配了代理 + 配了跳板机 → 第 1 跳经代理拨号，其余跳照旧 forwardOut
2. 只配了代理           → sock = socks5Connect(proxy, 目标)
3. 只配了跳板机         → 现状不变 connectChain()
4. 都没配               → 现状不变（ssh2 自己直连）
```

- `connectClient()` `src/index.js:865`：把"算 sock"抽成一个统一函数，代理与跳板机在这里一起决定；
- `openRepairedSock()` `src/index.js:1045`：把内部的 `net.createConnection`（`src/index.js:1049`）换成"按代理配置决定的拨号器"，否则 banner 修复路径会绕过代理；
- `connectChain()` `src/index.js:1076`：给第 1 跳注入代理 socket。

**资源清理**：现有失败路径只回收跳板连接，新增的代理 socket 也必须在失败/取消时销毁，否则重试会泄漏连接。重连路径（`connectClient` 再次被调用，见 `src/index.js:1220`）会按同一份代理配置重新拨号，行为与跳板机一致。

### 4.3 资源记录加可选 `proxy` 字段（沿用既有零迁移模式）

`profileRecordSchema`（`src/index.js:141`）里已有多个**可选**字段，注释明确写了"optional 以免老数据需要迁移"（`src/index.js:151`–`src/index.js:152`、`src/index.js:154`、`src/index.js:160`），`hostKeyMode`（`src/index.js:150`）、`credentialId`（`src/index.js:153`）、`defaultProjectPath`（`src/index.js:159`）、`loginCommand`（`src/index.js:164`）、`proxyJump`（`src/index.js:165`–`src/index.js:168`）都是这个套路。新增 `proxy` 沿用同一模式即可，**无需存储迁移**：

```js
proxy: { type: "socks5", host, port, username? }   // 记录里的形状；密码不落库
// 同一记录里并列一个派生布尔（供 UI 显示"已配置代理凭据"）：
proxyCredentialConfigured: boolean
```

协议面同步（密码**不进记录**。本地补丁最终采用与主密码、跳板机密码完全一致的"保存接口返回 ref、前端直接写凭据库"方案，密码**不经过 `profileSave` 请求体**，避免密码落 RPC 日志；一次性连接请求才内联 `password`）：

| 面 | 形状 | 说明 |
| --- | --- | --- |
| 保存请求 | 仅 `proxy: { type, host, port, username? }`（可选）；密码经返回的 `credentialRefs.proxyPassword` 由前端 `credentials.set` 写库 | 密码与保存 RPC 体分离，不落日志；留空表示保持原值，另有清除勾选 |
| 记录 / 展示 | `proxy: { type, host, port, username? }`（**不含密码**）+ `proxyCredentialConfigured: boolean` | 与既有 `credentialConfigured` 同风格 |
| 连接请求 | `proxy: { type, host, port, username?, password? }` | 临时连接可一次性带密码 |

对应到既有 schema：`connectRequestSchema`（`src/schemas.js:62`，`proxyJump` 在 `src/schemas.js:83`）、`profileSaveRequestSchema`（`src/schemas.js:212`，`proxyJump` 在 `src/schemas.js:216`）、`profileInfoSchema`（`src/schemas.js:230`，`proxyJump` 在 `src/schemas.js:243`）各加可选字段。

### 4.4 代理密码走凭据库，ref 与既有命名同构

沿用 `profileCredentialRefs()`（`src/index.js:288`）与跳板机凭据 ref（`src/index.js:325`–`src/index.js:335`）的命名风格：

```
DSH_SSH_OPS_<STEM>_PROXY_PASSWORD
```

删除资源时同步 `unset` 该 ref（对齐 `profileDelete` 的清理逻辑 `src/index.js:1454`）。

### 4.5 域名原样透传（atyp=3），不在本地做 DNS

内网域名只有代理侧能解析，本地 `resolve` 必然失败。客户端应把域名按 RFC 1928 的 `atyp=3` 编码后原样交给代理。

### 4.6 错误诊断与重试分类

代理类失败必须给出可读原因，不能退化成"重试到超时"：

| 场景 | 建议 code | 是否可重试 | 用户可见方向 |
| --- | --- | --- | --- |
| 连不上代理 | `proxy-unreachable` | ✅ 可重试（走既有退避） | 代理不可达（检查地址/端口/网络） |
| 代理无响应 / 静默关闭（含转发型代理回 `rep=0` 后 0 字节关闭） | `proxy-timeout` | ✅ 可重试（走既有退避） | 提示目标可能需填 `127.0.0.1` + 代理侧端口 |
| 代理要求认证但没配 | `proxy-auth-required` | ❌ 永久，立即报错 | 该代理要求用户名/密码 |
| 代理拒绝账号密码 | `proxy-auth-failed` | ❌ 永久，立即报错 | 代理认证失败，核对用户名/密码 |
| 代理拒绝 CONNECT | `proxy-rejected` | ❌ 永久，立即报错 | 代理拒绝连接目标（附 rep 码含义） |

**分类理由**：超时/不可达是网络或代理侧的**暂时**状况，重试有意义；认证失败与规则拒绝是**确定性**结论，重试只会让用户白等好几轮退避。

实现落点：`src/net-errors.js:8` 的 `TRANSIENT_CODES` 是**白名单**判定（`isTransientConnectError`，`src/net-errors.js:21`），且**未知 code 直接判永久**（`src/net-errors.js:23`）——因此 `proxy-unreachable` 与 `proxy-timeout` **必须显式加入**该集合才能获得重试；`proxy-auth-*` / `proxy-rejected` 则**不得加入**。

### 4.7 UI 与文档提示

资源表单（「跳板机（ProxyJump）」区块在 `src/client/SshResources.jsx:280`，高级选项开关在 `src/client/SshResources.jsx:284`）与快速连接面板（`src/client/SshPanel.jsx:469`、`src/client/SshPanel.jsx:738`）各加一个代理区块，并明确提示两种填法：

- **标准 SOCKS5 代理**：目标填**真实服务器地址**；
- **端口转发式代理**：目标填 `127.0.0.1`，端口填**代理机侧的端口**。

### 4.8 本期明确不做

HTTP/HTTPS CONNECT 代理（仅预留 `type` 字段）、全局默认代理、纯 SOCKS5 直连数据库（`db-ops.js` 目前只走 SSH 隧道，`src/db-ops.js:331`）、代理链。

---

## 五、兼容性

- **不破坏既有数据**：`proxy` 为可选字段，老资源照常加载，**零存储迁移**（与 `proxyJump` / `hostKeyMode` / `loginCommand` 完全同一模式，见 `src/index.js:141` 起的既有注释）。
- **不配代理时行为完全不变**：拨号路径在无代理配置时走原分支，`connectClient` 的 `sock` 仍为 `undefined` 交给 ssh2 直连；`openRepairedSock` 的直连语义不变。
- **不影响现有 SOCKS5 服务端**：`src/socks5.js` 与 `tunnelStartDynamic`（`src/index.js:4001`）一字不动，`ssh -D` 动态隧道行为不变。
- **既有测试不受影响**：新增客户端模块与现有 `test/socks5.mjs` 覆盖的服务端互不影响；新测试可用插件自带的 `attachSocks5` 当测试对端，零新依赖、离线可跑。

---

## 六、可行性验证（代理侧探测，供维护者参考）

> 本节只说明**需求可行**：下述结论来自对代理的**原始协议探测**（直接与代理端口收发 SOCKS5 报文），不是本插件的实现结果。本 issue 是需求建议，插件侧实现尚未落地。

- 代理 `192.168.10.4:1080` + 目标 `192.168.10.11:22`：`CONNECT` 后拿到 banner `SSH-2.0-OpenSSH_7.4`，与直连该目标的 banner **逐字节一致**（见第三节）——说明"经 SOCKS5 转发 SSH 传输层"在协议上完全可行；
- 代理 `192.168.10.4:18092` + 目标填 `127.0.0.1:3306`：收到 MySQL `5.5.50` 握手，说明转发型代理同样可用，只是目标地址填法不同；
- 方法协商实测表明"有凭据才声明 `0x02`"是实现时必须遵守的约束（见 3.2）；
- 其余可行性判断（三处拨号点是否覆盖完整、零迁移是否成立）均为**对现有源码的静态阅读结论**，已在上文给出确切行号，供维护者复核。

---

## 七、参考

- RFC 1928（SOCKS Protocol Version 5）、RFC 1929（Username/Password Authentication for SOCKS V5）
- 本仓库现有实现：`src/socks5.js`（服务端）、`src/index.js:1076` `connectChain()`（跳板机）、`src/index.js:865` `connectClient()`
- 相关既有能力文档：README「跳板机（ProxyJump）」「端口转发」两节
