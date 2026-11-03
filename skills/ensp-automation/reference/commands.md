# eNSP / VRP 命令速查（插件内置）

> 用法：**先查这张表**。表里有的命令直接下发，不要联网搜。
> 只有设备真的回了 `Error: ...` / `Unrecognized command` / `Wrong parameter`，才去搜，
> 搜到并实测通过后，把命令补进这张表（注明机型）。
>
> 机型缩写：`S` = S3700/S5700 交换机，`AR` = AR2220，`USG` = USG6000V 防火墙。
> 标 ✅ 的在本机实测过；标 📘 的取自课程课件（厂商文档写法）。

## 0. 通用

| 用途 | 命令 | 机型 |
| --- | --- | --- |
| 进系统视图 / 退出 / 回用户视图 | `system-view` / `quit` / `return` | 全部 ✅ |
| 改设备名 | `sysname FW` | 全部 ✅ |
| 保存 | 用户视图 `save` → 回 `y`（S5700 还会问文件名，直接回车） | 全部 ✅ |
| 看当前配置 | `display current-configuration` | 全部 ✅ |
| 只看某段 | `display current-configuration \| include 关键词` | 全部 ✅ |
| 看接口 IP/状态 | `display ip interface brief` | 全部 ✅ |
| 看路由表 | `display ip routing-table` | 全部 ✅ |
| 清屏 / 关分屏 | `screen-length 0 temporary` | 全部 📘 |

## 1. 交换（VLAN / 二层）— S

```text
vlan batch 10 20 30                       # 批量建 VLAN
interface GigabitEthernet0/0/1
 port link-type trunk
 port trunk allow-pass vlan 10           # trunk 放行
interface GigabitEthernet0/0/3
 port link-type access
 port default vlan 30                    # access 加入
interface Vlanif10
 ip address 8.8.8.4 24                   # 三层网关
display vlan                              # 验证
```
✅ 全部实测（任务1 ARP 实验）

## 2. ARP 安全 — S

```text
arp learning strict                                     # 全局严格学习 ✅
arp anti-attack entry-check fixed-mac enable            # ARP 固化（fixed-mac）✅
arp-miss speed-limit source-ip 10.10.10.2 maximum 40    # 基于源 IP 的 ARP Miss 抑制 ✅
arp-miss speed-limit source-ip maximum 20               # 全局默认值 ✅
arp speed-limit source-ip 9.9.9.2 maximum 10            # 基于源 IP 的 ARP 限速 ✅
interface GigabitEthernet0/0/1
 arp-limit vlan 10 maximum 20                           # 接口 ARP 报文限速 ✅
display arp learning strict                             # 验证 ✅
display arp                                             # 看表项 ✅
```

## 3. 防火墙基础 — USG

```text
interface GigabitEthernet1/0/1
 ip address 192.168.1.1 24
 service-manage ping permit              # 允许 ping 该接口 ✅
firewall zone trust
 add interface GigabitEthernet1/0/1      # 加入安全区域 ✅
firewall zone untrust
 add interface GigabitEthernet1/0/2
firewall zone dmz
 add interface GigabitEthernet1/0/1      # dmz 侧（服务器区）✅
display zone                             # 验证区域成员
display ip interface brief               # 验证接口 ✅
```
默认账号 `admin` / `Admin@123`；首次登录可能被要求改密（`new_password` 参数）。✅

## 4. 安全策略 — USG

```text
security-policy
 rule name untrust_to_dmz
  source-zone untrust
  destination-zone dmz
  source-address 192.168.1.0 24          # 可选
  destination-address 192.168.1.0 24     # 目的 NAT 场景要写转换后的地址 ✅
  service http                           # 可选，不写=any
  action permit
display security-policy rule all          # 验证 ✅
```

## 5. 源 NAT（NAPT / Easy-IP）— USG

```text
# 地址池方式（NAPT）
nat address-group NAT_POOL
 mode pat
 section 0 2.2.2.11 2.2.2.15             # 地址池范围 ✅
nat-policy
 rule name NAPT
  source-zone trust
  destination-zone untrust
  source-address 192.168.1.0 24
  action source-nat address-group NAT_POOL ✅

# Easy-IP（借用出接口地址，不用地址池）
nat-policy
 rule name EASYIP
  source-zone trust
  destination-zone untrust
  source-address 192.168.1.0 24
  action source-nat easy-ip ✅

display nat-policy rule all               # 验证（含 HITS 计数）✅
display firewall session table            # 看转换结果 ✅
```

## 6. 目的 NAT / NAT Server / 双向 NAT — USG

```text
# 目的 NAT（地址池 + 静态一对一）
destination-nat address-group addressgroup1
 section 192.168.1.10 192.168.1.10        📘
nat-policy
 rule name untrust_to_dmz
  source-zone untrust
  destination-address 2.2.10.10 32
  service http
  action destination-nat static address-to-address address-group addressgroup1 📘

# NAT Server（双向 NAT 里用它对外发布服务器）
nat server POLICY_WEB protocol tcp global 2.2.10.10 www inside 192.168.1.10 www unr-route 📘
nat server POLICY_FTP protocol tcp global 2.2.10.11 ftp inside 192.168.1.11 ftp unr-route 📘

# 双向 NAT 的源 NAT 部分（外网访问内网时把源地址也转掉）
nat address-group addressgroup1
 mode pat
 section 0 192.168.1.20 192.168.1.25
 route enable                             📘
nat-policy
 rule name untrust_to_dmz
  source-zone untrust
  destination-zone dmz
  destination-address range 192.168.1.10 192.168.1.11
  service http ftp
  action source-nat address-group addressgroup1 📘

# FTP 的 NAT ALG
firewall interzone dmz untrust
 detect ftp                               📘

display firewall server-map               # NAT Server 表项 📘
display firewall session table            # 会话表 ✅
```
> 记忆点：**目的 NAT 在安全策略之前处理**，所以安全策略里写的是「转换后」的内网地址。📘

## 7. 路由 — 全部

```text
ip route-static 0.0.0.0 0.0.0.0 2.2.2.254        # 默认路由 ✅
ip route-static 2.2.2.0 255.255.255.0 NULL0      # 黑洞路由，防 ARP 风暴 ✅
ip route-static 2.2.10.10 255.255.255.255 2.2.2.1 # 把公网映射地址指回防火墙 📘
display ip routing-table protocol static          # 验证
```

## 8. 验证与抓证据

```text
ping -a 192.168.1.2 -c 5 8.8.8.8        # 指定源地址 ping ✅
display arp                              # 学到主机 = 二层通 ✅
display firewall session table           # NAT 是否生效（看方括号里的转换后地址）✅
display nat-policy rule all              # 策略命中计数 ✅
display firewall server-map              # 目的 NAT 表项 📘
display current-configuration | include nat     # 兜底：直接看配置 ✅
```

## 9. 报错 → 处理

| 回显 | 含义 | 处理 |
| --- | --- | --- |
| `Error: Unrecognized command found at '^' position.` | 命令不存在 / 视图不对 / 上一行的 `y` 被当命令 | 确认视图；`save` 用 `save\ny\n` 一次写（插件已内置） |
| `Error: Wrong parameter found at '^' position.` | 参数写错（常见：漏空格、掩码写成 `/24`） | 用 `ip address 1.1.1.1 24` 这种写法，不要 `/` |
| `Error: The address already exists.` | 拓扑预配了该地址 | 先 `display ip interface brief`，已配就跳过 |
| `Error: The route already exists.` | 路由已存在 | 同上，先 `display ip routing-table` |
| `Error: Too many parameters found at '^' position.` | 参数多了（常见 `include` 后面带引号） | `display current-configuration \| include nat`（不要引号） |
| `console authentication failed for user "admin"` | 口令不对 | 试 `Admin@123`，再试改密后的口令 |
| `The password needs to be changed. Change now? [Y/N]:` | 出厂口令强制改密 | `ensp_cli` 传 `new_password` |
| `Please input the file name ( *.cfg, *.zip ) [vrpcfg.zip]:` | S5700 保存时问文件名 | 直接回车（插件已内置） |
| `Info: The configuration takes effect after being saved` 之类提示 | 正常 | 继续 |

## 10. 命令拿不准时的顺序

1. 查本表 → 2. `ensp_cli` 试一条 `display ?` / `命令 ?` 看设备自己的帮助 →
3. 还不行才联网搜（优先华为官方文档/配置指南）→ 4. 实测通过后补进本表。
