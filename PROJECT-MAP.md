# 项目导览图 PROJECT-MAP

这是一张"我想改某样东西，该去哪个文件"的地图。不需要懂全部代码，照着找就行。

> 一句话原则：**改内容（人、项目、新闻……）只动 `content/` 里的 JSON，永远不要改代码。**
> 改样式/颜色/交互逻辑才进 `apps/` 和 `packages/`。

---

## 目录总览

这是一个 **monorepo**（一个仓库装多个子项目），用 npm workspaces 管理。

```
groundtruth/
├── content/          ← 【内容数据】人、研究、项目、课程、showreel —— 全是 JSON
│   ├── *.json        ← 你平时要改的就是这些
│   ├── schema.ts     ← 内容的"形状"定义（字段有哪些、哪些必填）
│   └── media/        ← 图片/视频等媒体文件（按类型分文件夹）
│
├── apps/             ← 【三个可运行的程序】
│   ├── kiosk/        ← 大屏幕展示端（玻璃后的那块屏）
│   ├── controller/   ← 手机端（扫码后变成的"触控板"）
│   └── relay/        ← 中转服务器（决定谁在控制、转发输入）
│
├── packages/         ← 【多个程序共用的东西】
│   ├── tokens/       ← 设计令牌：所有颜色、主题（唯一能写颜色的地方）
│   ├── ui/           ← 可复用组件库（如 Logo），配 Storybook
│   └── protocol/     ← 手机↔服务器↔大屏 的通信"协议"类型 + 超时常量
│
├── docs/             ← 【规格文档】设计系统、架构、内容模型、路线图
├── assets/           ← 【品牌源文件】TUM logo、官方颜色 PDF
├── scripts/          ← 【工具脚本】如内容校验器 check-content.ts
├── CLAUDE.md         ← 项目宪法（怎么造这个项目的总规矩）
└── PROJECT-MAP.md    ← 你正在看的这份
```

---

## 想改某类东西 → 去哪个文件

### A. 内容（最常改，纯 JSON，不碰代码）

| 我想… | 改这个文件 |
|---|---|
| 加/改一位成员、改简介、换头像 | `content/people.json` |
| 给某人加详情页的多张照片 | `content/people.json` 里那个人的 `photos` 数组 |
| 加/改一个研究方向 | `content/research-topics.json` |
| 加/改一个学生项目/论文 | `content/student-projects.json` |
| 加/改一门课 | `content/courses.json` |
| 加一条新闻 / 首页轮播项 / 招募启事 | `content/showreel.json`（新闻 = `"kind": "news"`） |
| 放一张本地图片进去 | 丢进 `content/media/对应类型/`，JSON 里写文件名 |

> 注：头像/封面也可以直接写一个网址（`http://…`），就不用放本地文件。当前假数据用的就是
> DiceBear 头像和 picsum 占位图的网址。
>
> **改完务必跑一次校验：** `npm run check:content`（绿色才安全）。它会查：JSON 写错没、
> 必填字段缺没缺、id 有没有重复、互相引用的 id 存不存在、本地图片在不在。
>
> 内容的字段规则、维护教程见 `docs/content-model.md`。

### B. 外观 / 样式 / 品牌

| 我想… | 去哪 |
|---|---|
| 改任何颜色、改 light/dark 主题 | `packages/tokens/src/`（`palette.ts`、`themes.ts`、`tokens.css`）。**颜色只能在这里写**，别处禁止硬编码 |
| 改 Logo 的用法/白色版 | `packages/ui/src/components/Logo/`；源文件在 `assets/logo/` |
| 加一个新的可复用组件 | `packages/ui/src/components/`（每个组件配一个 `.stories.tsx`） |
| 看/调组件（组件工作台） | `npm run storybook` |
| 设计规范（颜色含义、排版、动效原则） | `docs/design-system.md` |

### C. 大屏（kiosk）行为

| 我想… | 去哪 |
|---|---|
| 调光标灵敏度/惯性手感 | `apps/kiosk/src/config.ts`（`SENSITIVITY`）、`apps/kiosk/src/components/Cursor.tsx` |
| 改二维码指向的网址 / 这台屏的房间号 | `apps/kiosk/src/config.ts`（`VITE_CONTROLLER_URL`、`VITE_SESSION_ID` 等环境变量） |
| 改二维码长相/位置 | `apps/kiosk/src/components/KioskQR.tsx` |
| 改 idle/interactive 的页面 | `apps/kiosk/src/App.tsx`（更完整的分区在后续 Phase 加） |

### D. 手机端（controller）行为

| 我想… | 去哪 |
|---|---|
| 改触控板手势（拖动/点按/双指滚动/鼠标支持） | `apps/controller/src/components/TrackpadSurface.tsx` |
| 改 driver/排队/让出控制 的界面 | `apps/controller/src/App.tsx` |
| 改手机端样式 | `apps/controller/src/index.css` |

### E. 服务器 / 通信规则

| 我想… | 去哪 |
|---|---|
| 改"谁在控制"的排队逻辑、超时释放 | `apps/relay/src/rooms.ts`（状态机） |
| 改 idle 超时(60s)、心跳间隔等常量 | `packages/protocol/src/index.ts`（`TIMING`） |
| 改消息协议（新增/改一种消息） | `packages/protocol/src/index.ts` —— **改这里前先看 CLAUDE.md 规则 8** |
| 改服务器端口 / CORS / 输入限频 | `apps/relay/src/config.ts` |

---

## 常用命令（都在仓库根目录跑）

```bash
npm run check:content   # 校验内容 JSON（改完内容必跑）
npm run dev:kiosk        # 起大屏 app
npm run dev:controller   # 起手机端 app
npm run dev:relay        # 起中转服务器
npm run storybook        # 组件工作台
npm run typecheck        # 全仓库类型检查
```

完整运行/真机测试步骤、各阶段进度见 `docs/roadmap.md`。

---

## 当前进度（截至 Phase 2 第一部分）

- ✅ 已搭好：通信骨架（手机控制大屏）、设计令牌、组件库骨架、内容数据层 + 校验器。
- 🚧 还没做：内容的**界面/卡片/布局**（Phase 2 后半段及之后），WebGL 视觉，等待区小游戏。
- ⏸ 跨网络（4G+eduroam）真机测试：等服务器公网部署后再做。

> 这份地图随项目演进更新；新增文件夹/重要文件时记得补上。
