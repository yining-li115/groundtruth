# Groundtruth 手势交互改造方案 v2

> 实施状态（2026-09-17）：本文件保留为**改造前的问题证据与实施决策记录**。除本页
> 紧接着的“当前实施结果”外，后文的“现状”“尚未”“应新增”等措辞都指 2026-09-10
> 审计时的旧代码，不再描述运行中的系统。当前运行契约以 `docs/gesture-input.md` 为准。
>
> 旧 `steer()`、`useHandFlight.ts`、`Showreel.tsx`、`ShowreelStage.tsx` 及其私有飞行语法
> 已从生产路径删除；保留的 `/?exp=cv` 是隔离诊断实验，不属于生产手势系统，也不会与
> kiosk 同时创建第二条摄像头流。

修订日期：2026-09-10。基于 v1（`Groundtruth_Gesture_Control_Plan_v1.md`，由外部模型依据 `docs/gesture-input.md` 撰写，未接触仓库）。

**本版做了什么**：把 v1 的每一条关于本仓库的断言拿源码核对，能跑的用测试骨架跑出数字，外部引用逐条访问核实；改正说错的，删掉与现有版面/已决策冲突而 v1 未察觉的，补上 v1 无从知道的项目硬规则，并把"新增七个模块"落到真实文件边界上。**v1 的骨架是对的**，绝大部分保留。

标记约定：✅ 已在本仓库核实 · 📏 本次实测得到数字 · ⚠️ 已更正 · ❌ 已删除或否决 · 🆕 v1 没有、本版补入。

---

## 当前实施结果（2026-09-17）

- **唯一生产输入链**：`HandControl` 是唯一入口；`videoFrameSource.ts` 每个新解码帧只
  推理一次并发布单调 `seq`，冻结、轨道结束和页面隐藏会使输入失效；结果 freshness
  根据该笔记本实际推理耗时/产出节奏在 120–800ms 内调整，推理本身超过 500ms 则拒绝；
  已确认的同 owner UI 操作在 120–800ms 自适应 live lease 之后还有 350ms 的有界
  landmark 闪断宽限；live lease 一过滚动速度立即归零，但事务可等待同 owner 恢复，且
  绝不把缺测当作松手。
- **稳定归属**：`handOwner.ts` 不再信任 MediaPipe 的 `hands[0]` 顺序，而用位置与尺度
  连续性选定临时 `ownerId`；`faceOwner.ts` 把作为尺度尺子的脸绑定到这只手，而不是取
  最大脸。短闪断期间只保留原 owner；超过有界宽限或换手才取消，绝不把会话交给旁人。
- **稳定光标而不拖慢运动**：默认指向点是 wrist，不再是会随握拳变形的 palm triangle。
  One Euro 后增加每个 owner 独立的自适应静止死区；换人立即重置。Showreel Explore
  复用校准后的 live 坐标及自己的中心死区，因此不同设备共享同一“舒适中心”语义。
- **统一仲裁**：`interactionRouter.ts` 在 `CALIBRATION` / `POINTING` / `UI_PRESS` /
  `UI_SCROLL` 之间独占路由；Showreel 的 open-hand Explore 只在 neutral-armed
  `POINTING`、非 UI、fresh owner 时取得 scene session。控件在确认按下时锁定，未移动的主动松拳才点击一次；
  UI、握拳、unknown、丢手、过期、换手与模式切换都会立即停止场景输入。
- **v4 安装校准**：默认 mapping 是 2.7 × 1.8 faces、drop 2.2，默认 click 是 fist。
  profile 按 camera identity + 完整 display geometry 定位，只存 camera/display、限制在默认
  70–100% 的 box 与 `validated`；不再存 pinch、jitter、palm、click 或时序。流程只有三段：
  五方向舒适 hold → 当前配置手势 3 次 → mapped broad zones；从不要求触碰屏幕角点。
- **Showreel 自动 Explore**：无人时自动巡游并轮播 news；稳定手出现立即冻结。开放手以
  校准后的舒适中心为 joystick，左右控制连续转向、上下控制沿水平 heading 的前后移动；
  UI、握拳或 unknown 时保持当前视角。手离开后沿已验证 breadcrumb 安全回程，到达原
  tour pose 才恢复巡游/news。生产界面不再有 LOOK/MOVE 选择，也没有背景握拳抓取。

因此生产环境不再存在“三套各自解释手势”的情况：识别、归属和事件只生成一次，
`HandControl`/router 决定唯一接收者，Gaussian 控制器只消费已授权的 `SceneIntent`。

---

## 0 · v1 → v2 变更一览

| # | v1 的说法 | 本版处理 |
|---|---|---|
| 1 | 手离开后飞行不应沿旧速度持续 1.2s（§8 末） | ✅📏 **当时成立且复现**：实测持续 **1221 ms**；现由 freshness/cancel 与 scene TTL 修复 |
| 2 | `hands[0]` 无稳定归属、硬编码 1280、无解码帧仍报运行（§3） | ✅ 审计时三条都成立；现分别由 stable owner、真实 frame size、decoded-frame watchdog 修复 |
| 3 | 2 帧 / 8 帧等常数随帧率改变语义（§8） | ✅ 成立；现直接使用 unique decoded sample 时间戳的毫秒门，清单见 §1.3 |
| 4 | 第一版目标"三轴平移 + 环顾"（§1） | ⚠️ 审计时生产链路没有平移；最终生产语法收敛为两轴自动 Explore：左右连续转向、上下前后移动，不提供升降或独立 strafe |
| 5 | 复用 Spark `PointerControls` 的释放惯性（§2 R2） | ⚠️ 本地类型确认它确有 `rotateInertia/moveInertia/rotateVelocity/moveVelocity`，但整个类由 canvas 的 pointerdown/move 驱动。要复用必须合成 PointerEvent，等于把飞行控制绑进 DOM 事件并丢掉可测试性。**结论改为：借参数形状，不借实现**（§1.5） |
| 6 | §4.1 "不因为手出现就开始飞行，先给被看到的反馈" | ⚠️ 最终由产品语义覆盖：稳定手出现即冻结 tour/news，并在开放手、非 UI 时自动 Explore；无需额外抓取 |
| 7 | §4.3/4.4 底部中央移动区 + 右下高度区 | ❌ **与现有版面正面冲突**：底部中央是 Enter 按钮（`showreelFlight.css` `bottom: 3rem`）+ 手势提示（`3.5rem`），左下在内容页是 Home 区。v1 版删除，移入 v2 并给出版面前提（§2.3） |
| 8 | §6.4 "第一版关掉释放惯性" | ⚠️ 中间版为 LOOK 实现过守卫惯性；最终自动 Explore 是中心 joystick，离开输入条件立即 hold，不在生产路径使用释放惯性 |
| 9 | §9 七个新模块 | ⚠️ 审计时估计只需新增 3 个；最终按纯逻辑边界拆为 frame source、owner、router、scene navigation，见 §5 |
| 10 | §11 验收门槛 | ⚠️ 门槛保留，但全部挂到仓库已有的三个 harness 上，否则无人知道该在哪里跑（§6） |
| 11 | — | 🆕 补入项目硬规则：设计令牌、不擅自加库、Storybook、URL 旋钮惯例（§0.1） |
| 12 | — | 🆕 审计补入 P0：重复解码帧；现由 `requestVideoFrameCallback` 与 fallback 去重修复 |
| 13 | 外部引用 R1–R8 | ✅ 已逐条访问核实，含 Oracle 源码的具体断言；一处补充见 §1.7 |

### 0.1 🆕 任何实现都必须遵守的项目规则

来自 `CLAUDE.md`，v1 不可能知道，但违反其中任何一条都会导致返工：

- **颜色只能来自 `packages/tokens`**。新增的提示、区域、光标状态一律不许写十六进制。WebGL 场景资产（高斯、天空）走"资产色"例外，且必须放在场景旁边一个明确命名的文件里。
- **禁止新增状态库**（只有 zustand）、**禁止 CSS-in-JS**、**禁止 Next.js**。需要清单外的库要先问。
- **可复用组件必须配 `.stories.tsx`**，没有故事的组件算没做完。
- **一个摄像头、一套模型，只在 `App.tsx` 挂载一次**。任何想要手部输入的东西读 `HandControl` 发布的结果，绝不自开第二条流。
- **URL 旋钮惯例**：本项目所有手感参数都可以 `?key=value` 现场覆盖（`config.ts`、`SparkCampusExperiment.tsx` 里几十个 `num()` 就是这个约定）。**本方案新增的每一个常数都必须照办**——墙上调参不能靠重新部署。
- 改动 `apps/`/`packages/` 结构、替换锁定的库、改协议，要先打招呼。

---

## 1 · 核对结果

### 1.1 📏 历史故障：手离开后，相机继续飞 1221 毫秒

v1 §8 末尾提到"飞行不可沿旧速度持续 1.2s"。**审计时成立，且比推测更确定。**

根因（三处代码合起来才成立，任何一处单看都无异常）：

1. `HandControl.tsx` 的飞行分支门控在 `s.present`：`if (!store.entered && s.present) steer(s.x, s.y, …)`。
2. `DEFAULT_POINTER.leaveMs = 1200`——手消失后 `present` 还要保持 1.2 秒才落下。
3. `HandPointer.update` 的位置只在 `if (palm && box)` 里写入。手没了，`s.x/s.y` 就**冻在最后一帧**。

于是 `steer()` 被继续以陈旧坐标调用，`latch()` 持续返回同一个方向，相机以满速继续飞，直到 `present` 落下才 `stopFlight()`。

复现（复用 `scripts/check-pointer.ts` 的合成手骨架，30fps 虚拟时钟）：

```
hand present, held to one side:      yaw=1  present=true
after the hand vanishes:             yaw kept non-zero for 1221ms
final:                               yaw=0  present=false
```

这是**最该先修的一条**，因为它在现场表现为"我手都放下了，画面还在自己转"——和"没识别到我"是同一种观感，却是完全不同的病。

**实施结果**：存在状态与动作授权已经分离。光标 presence 仍可防闪烁，但 scene
authority 只来自 fresh、active、owner-matched 的 `SceneIntent`；丢手与 stale 走 cancel，
renderer 使用 180ms 下限与每个样本携带的自适应 freshness budget，不会沿旧坐标继续飞。

### 1.2 ✅ v1 §3 的三条应用层故障在审计时全部属实

| 故障 | 位置 | 确认 |
|---|---|---|
| `hands[0]` 无稳定归属 | `mediapipe.ts` `allHands()` | **已修**：`StableHandOwner` 按空间/尺度连续性选择并锁定临时 owner，数组顺序不再有交互权 |
| 硬编码 1280 | `handPointer.ts` `confidence(face, box, palmNorm * 1280)` | 属实。**已修（2026-09）**：改读 `VisionResult.frame` 里摄像头真实解码的帧宽 |
| 无解码帧仍报 running | `useHandPointer` / `handStatus` | **已修**：首帧超时报告 error；运行中由 watchdog 将 frozen/ended/hidden source 失效并取消控制 |

### 1.3 ✅ 识别门已改为解码样本时间

v1 说"2 帧、8 帧随帧率改变语义"，属实。最终门限全部使用每个 unique decoded sample 自带的时间戳：

| 常数 | 目标时长 | 30fps 语义 | 15fps 语义 |
|---|---:|---:|---:|
| `FistLatch` on/off | 66 / 100 ms | 66 / 100 ms | 66 / 100 ms |
| `PINCH_SETTLE_MS` | 265 ms | 265 ms | 265 ms |
| `PINCH_GRACE_MS` | 165 ms | 165 ms | 165 ms |
| `PINCH_ON_MS` / `PINCH_OFF_MS` | 100 / 100 ms | 100 / 100 ms | 100 / 100 ms |

时间只在新的解码样本到达时推进；低帧率只会带来最多一个样本的量化延迟，不会让门时长翻倍。因此 profile 仍可记录 fps 用于诊断，但它不再配置识别门。`check:pointer` 用 30fps / 15fps 虚拟时钟固定这一语义。

### 1.4 ⚠️ 审计时生产链路只有两个自由度

v1 §1 把"三轴平移 + 环顾"写成第一版目标，读起来像是在改进当时已有的平移。**审计时的生产链路没有平移。**

当时 `flightInput.ts` 的 `steer()` 只写 `yaw`（左右转）和 `dolly`（前后），**从不写
`strafe` 和 `lift`**；已删除的 `useHandFlight.ts` 另有一套私有语法和摄像头入口。
最终生产实现不再复用这些字段，而是发布带 session/owner/seq/freshness 的自动 Explore
intent：校准中心相对 x 是连续 yaw rate，y 是前后速度。

所以审计时的结论是：**握持中的访客能做的只有"转"和"前后"**。这不改变 v1 的方向，但改变优先级——平移是新功能，排在"先让转向不难受"和"先修 P0"之后。

### 1.5 ⚠️ Spark 控制器：借参数，不借实现

`node_modules/@sparkjsdev/spark/dist/types/controls.d.ts` 确认 `PointerControls` 暴露：

```ts
rotateSpeed  slideSpeed  scrollSpeed  moveInertia  rotateInertia
rotateVelocity: THREE.Vector3   moveVelocity: THREE.Vector3
pressMoveDelayMs  pressMoveAccelMs  pressMoveSpeed  …
```

即 v1 R2 描述的能力确实存在。**但**：整个类由绑在 canvas 上的 `pointerdown/pointermove/pointerup` 驱动，状态是 `PointerState { initial, last, position, pointerId, … }`。要用它，只能把手的位置合成为 PointerEvent 派发到 canvas——这会把飞行控制绑死在 DOM 事件上，绕过抓取会话，并且**再也无法离线测试**（pointer harness 的价值就在于不需要浏览器）。

审计时 `SparkCampusExperiment.tsx` 的 `manual` 块证明了相机数学必须从 React/DOM 输入中
抽离。中间 LOOK 版本采用抓取基准相对位移；最终生产 Explore 改为校准中心 joystick，
由 `sceneNavigation.ts` 按真实 `dt` 积分有界 turn/travel 速度。两版都保持单一相机写入者
和可离线测试性。

**结论**：把 `rotateInertia`/`moveInertia` 当作参数形状与命名的参考，实现留在自己这边。

### 1.6 🆕 历史故障：约一半的推理花在重复帧上

v1 §8 说"只推理新解码的视频帧"。核对下来这不只是优化，是**现状就在浪费**：

`useHandPointer` 的循环挂在 `requestAnimationFrame`（≈60Hz），除了 `video.readyState < 2` 之外**没有任何一处检查这一帧是不是新解码的**，每次都照跑 `engine.process(video, ts)`；而摄像头只以 ~30fps 解码。代码里的 `if (ts <= lastTs) ts = lastTs + 1` 是为满足 MediaPipe"时间戳必须严格递增"的要求，它保证了调用不会因为时间戳相同被拒绝——但它不认识"同一张画面"，所以同一帧会被当成两帧各跑一遍两个模型。

同一帧上还跑着 `FaceDetector`（人脸在这里只当尺子用，5–10Hz 足够）和 `numHands: 2`（下游只读 `hands[0]`）。

**实施结果**：`videoFrameSource.ts` 使用 `requestVideoFrameCallback` 驱动推理，每个解码
帧恰好一次；兼容路径按 `currentTime` 去重，独立 watchdog 负责无回调时的 stale。
`numHands: 2` 保留给稳定 owner 选择，渲染循环只读最新状态，不会重复消费同一 `seq`。

### 1.7 ✅ 外部引用核实结果

逐条访问确认（2026-09-10）：

- **R1 Oracle World Explorer** — 仓库存在。README 自述："Built during the World Labs hackathon (March 2026)"。栈为 Three.js 0.170 + Spark + MediaPipe + World Labs Marble API + Gemini 2.0 Flash Live。v1 对其源码的两条断言**逐字属实**：握拳判据是 `const isFist = [8, 12, 16, 20].every(i => lm[i].y > wristY);`（图像纵坐标规则，非旋转不变，确实不适合替换我们的训练分类器）；追踪丢失确实直接走释放回调（传 `false` / 归零）。
  - ⚠️ **v1 漏了一条**：它用的是**旧版 MediaPipe Hands / FaceMesh solutions**，不是我们用的 `tasks-vision` Task API。两者的 landmark 语义相近但 API、置信度含义和 world-landmark 支持不同，**照抄阈值无效**。
- **R7 gesturenav** — 存在，纯 Python、仅依赖 `math` 与 `dataclasses`，面向 MediaPipe 风格 landmark 的 pan/orbit/zoom 映射库。v1 的定性准确。
- R2 Spark、R6 One Euro、R8 MediaPipe Web 文档：见 §1.5 与 §1.3，本地核对一致。
- R3 camera-controls、R4 Handsfree.js、R5 TouchFree：本版**不引入**（分别是：与现有单一相机写入者冲突、上游已归档、需要 Ultraleap 专用硬件）。保留在参考列表，不进依赖。

---

## 2 · 交互语法（修订）

网页语义仍是：**开放手指向；握拳后松开点击，或保持握拳移动来抓住页面滚动；张开或稳定松拳后重新 neutral-arm。**
Showreel 是明确的例外：开放手本身就是 Explore 输入，握拳不是抓场景，而是停止场景并
把控制权留给 UI 点击。

### 2.1 最终决策：无人巡游，见手即 Explore

v1 §4.1 曾提议“不因为手出现就开始飞行”。这与当时 `ShowreelFlight.tsx` 的明确决策相反：

> The tour hands the camera over as soon as a hand is seen — not once some grip is discovered. A screen that keeps playing its own loop while somebody is standing in front of it waving reads as a screen that cannot see them.

最终产品决定恢复这条“见手即接管”的原则，但把它收紧为可验证的状态机：

- 无稳定手：自动 tour + news；
- 稳定开放手、scene ready、router neutral-armed、且光标不在 UI：自动建立 Explore session；
- 手在校准舒适中心：静止；左右偏移是连续 yaw rate；上下偏移是沿水平 heading 的
  forward/back velocity；
- UI、握拳、pinch 或 unknown：立即结束输入并保持当前视角；
- 手仍在画面时不自动回 tour；只有离开/失效后才沿 breadcrumbs 回到原 composed pose，
  然后恢复 tour/news。

因此“出现光标”和“相机响应”同时提供被看见的反馈，但 presence 本身仍不是运动授权；
fresh owner、明确 open、非 UI 和 scene session 才是。

### 2.2 自动 Explore：一个中心 joystick

生产不再要求在 Gaussian 背景握拳，也不再展示 LOOK/MOVE 选择。`sceneExploreAxes()` 把
校准后的 `liveX/liveY` 以 `(0.5, 0.5)` 为中心映射到 `[-1, 1]`。横轴经死区和响应曲线变为
连续转向速度，纵轴变为前后速度；回到中心就平稳停住。这样一只手无需眼球追踪、无需
额外模式切换，也不会把“回位”误判成另一种动作。

转向和移动都按真实 `dt` 在 bounded substeps 中积分；相同输入在 30Hz/120Hz 下等价。
前进方向使用当前相机的水平 heading，抬手不会爬升，roll 锁定。场景移动继续通过 roam
volume 逐轴检测碰撞并允许贴墙滑移。

自动 tour 与测试共享同一个 `buildProductionTourCurve()`；按不大于 1/4 cell 的弧长间隔
验证整条 spline。render loop 还会逐帧检查实际 `getPointAt()` 结果，任何 blocked pose
都会停在上一安全位置并发布失败，绝不让 Explore 从建筑体素中接管。

### 2.3 历史方案：LOOK/MOVE 与虚拟移动区（已废弃）

v1 §4.3/4.4 曾提议底部中央放一个移动区、右下放一个高度区。它与版面正面冲突：

- 底部中央是 **Enter 按钮 + 手势说明**（`showreelFlight.css`：`.sf-enter { bottom: 3rem }`、`.sf-invite { bottom: 3.5rem }`）。Enter 是整个屏幕上唯一真正重要的目标——它是进站口——按当前设计它必须是"一个大目标"，因为手驱动的光标不是鼠标，第一次交互最不该做的事就是要求精度。
- 左下在内容页是 Home 返回区（正在改造成更大的渐变区域）。
- 右下目前空着，但把"高度控制"放在一个路人看不出用途的角落，等于没有。

更根本的问题：这是给路人的一屏，说明只有一行字；额外模式和虚拟区域会与 Enter 抢
空间。中间实现曾先做 LOOK，随后提供可切换 LOOK/MOVE：

- 版面前提：Enter 与 Home 的位置先定稿；移动区不得与二者重叠，也不得覆盖正文。
- 语义前提：v1 §4.3 的"抓取点即虚拟摇杆中心、抓取后可离开控件矩形不重新命中"是对的，照留。
- 方向前提：前后以**当前 yaw 的水平朝向**定义，世界竖直单独控制——照留，理由（抬头不该无意爬升）成立。

这些内容只保留为设计过程记录。**最终决策覆盖它们**：删除生产 LOOK/MOVE 面板，采用
§2.2 的自动 Explore；内部 `look`/`move` mode 仅保留给 Spark authoring 与确定性测试。

### 2.4 网页点击 / 滚动 / Home

v1 §4.5–4.7 基本照留，逐条核对后的补充：

- **UI click**（§4.5）：确认握拳时锁定冻结 aim 下的控件，但不会当场点击；保持握拳且
  未越过移动阈值，随后主动松拳才派发一次 click。松拳不只认教科书式 `Open_Palm`：明确
  张手可释放；常见的 `None/Neutral` 必须先通过 non-fist latch，再保持开放拇指/食指间距
  180 ms。满环表示“闭合已接受、正在等待点击或滚动决策”，松手后的反馈才表示点击完成。
  短暂识别抖动、丢手、stale、换手和超时都只取消，绝不会补发点击。
- **UI_SCROLL**（§4.6）：速度滚动、死区、`t²` 缓动继续保留。**现已收紧**：位移一旦
  越过阈值，本次会话永久失去 click 资格；有锁定滚动接收者时转入 `UI_SCROLL`，没有时
  以 `moved` 取消，不会移回中心后补发点击。
- **Home**（§4.7）：✅ 与正在进行的改造一致（Home 变成更大的渐变区）。v1 的三条约束全部照留，尤其"已有捕获时经过 Home 不触发、不抢夺"——这条在实现渐变大区域时极易漏掉，因为区域一大，飞行/滚动过程中扫过它的概率就高。

---

## 3 · 相机与滤波（修订）

### 3.1 ✅ 两套坐标，v1 说得对

UI 使用已镜像、已校准到屏幕的绝对光标。生产 Explore 读取同一 mapping 的**未按压冻结
live 坐标**，由 `sceneExploreAxes()` 以校准中心归一化；这使内置屏、外接屏和不同摄像头
都共享同一个中心与可达范围。

`rawHand` camera-space 坐标仍保留给页面 drag 的锁定原点、内部 LOOK/MOVE authoring 和
诊断测试，但最终 Showreel 不再用背景握拳的 palm-span 相对位移。

### 3.2 ✅ Explore 用中心相对速度

最终公式是位置到速度，而不是位置到一次性角度：

```
axis = response((live - calibratedCentre) / reachableHalfRange, deadzone)
yawRate = -axisX * maxYawRate
dollyVelocity = axisY * maxDollySpeed
```

保持一侧会连续转向；回到中心死区会平滑停下。`SceneNavigationController` 在 bounded
substeps 中按真实 `dt` 积分，因此不会把同一个 display frame 或 camera sample 重复计成
额外位移。旧的 clutch-relative LOOK 数学仍有单元测试，但不再是生产交互。

### 3.3 移动与滚动用速度

v1 §6.3 的公式照留：

```
a = clamp((abs(d) - d0) / (d1 - d0), 0, 1)
v = sign(d) * vmax * a^gamma
```

✅ 与 `dragScrollVelocity` 同构（那边 `gamma = 2`，`d0 = 0.025`，`d1 = 0.28`，`vmax = 2400 px/s`，且有离线回归覆盖）。二维限幅、进出滞回照留。gamma 1.5–2 作为起点，🆕 并且**必须做成 URL 旋钮**。

### 3.4 历史 LOOK 释放惯性（生产已停用）

v1 §6.4 主张第一版关掉；中间 LOOK 版本曾实现受守卫的有限释放惯性：

但 v1 的担忧是真的：惯性最容易被拿来**掩盖语义冲突**——系统猜不出哪次是回位，就用惯性把抽搐糊过去。这正是要避免的。

**折中，且是可验证的折中**：

保留惯性，仅当**同时**满足以下四条才触发：

1. 这次操作是 LOOK（平移与页面滚动第一版无惯性——照 v1）；
2. 结束原因是**主动张手**，不是丢手、不是取消、不是进入 UI、不是超时；
3. 释放前 ~120ms 窗口内的位移**方向一致**（窗口内掉过头，按 0 速度释放）；
4. 速度超过一个明确的"扫动"下限——慢拖后松手不产生任何延续。

衰减为指数，时间常数约 0.8s，**总延续角度设硬上限**，并且下一次抓取立即清零。整体挂 `?fling=0` 可关。

这套逻辑仍由内部 LOOK 测试覆盖，但**最终自动 Explore 不以张手释放**：开放手就是输入，
UI/握拳/unknown 立即 hold，手离开走安全回程。因此生产 Explore 不触发该 fling。

### 3.5 ✅ 三种平滑分开调

v1 §6.4 的分层正确：观测滤波（One Euro，保留，用真实时间戳）/ 抓取中的相机跟随（先关掉多余层，测是否还需要很短的缓冲）/ 释放惯性（见上）。

⚠️ 补一条：本仓库的 `beta = 10` **不是抄来的**，是在归一化 0..1 单位下实测定出来的（论文默认 0.007 在这个单位下等于把自适应关掉；实测 4K 下快速横扫滞后 1299px vs 59px）。v1 "不复制其他项目的 beta"这条建议对本仓库已经满足，但**反过来也成立：我们的 10 不能被别的项目抄走**，它绑死在"输入是屏幕归一化坐标"这个前提上。

### 3.6 ✅ 推理频率与渲染频率必须解耦

v1 §6.5 正确，且比它以为的更要紧（见 §1.6）。落地要求：

- `HandPointer` 暴露一个**每个视觉帧自增一次的 `seq`**。抓取会话只在 `seq` 变化时累积位移增量——否则 60Hz 的渲染循环会把同一个 30Hz 的增量执行两遍，转速凭空翻倍。
- 速度型意图（滚动、将来的平移）可以在渲染循环按 `dt` 积分，但**必须带有效期**；超期立即归零。
- 切标签页回来或出现异常大的 `dt` 时重置，不补积分。现有代码已有 `Math.min(dt, 0.05)` 之类的护栏，但那是限幅不是重置。

这些要求现已落地：pointer 发布 decoded-frame `seq/freshAt`，router 拒绝重复/过期样本，
scene consumer 再做独立 TTL；生产 Explore 只在新 `seq` 更新目标速度，并在 bounded
substeps 中按真实 `dt` 积分转向和前后移动。

### 3.7 单一相机写入者：保留并收紧

v1 §6.6 担心"导览、手势、惯性、重置各自改 `camera.position/quaternion`"。审计确认
Spark render tick 本来就是唯一写入者，这个边界被保留。最终由 router/`flightInput`
记录 `sessionId`、`ownerId`、mode、freshness 与 end reason，`SceneNavigationController`
只负责相机数学，render tick 仍是唯一真正写 pose 的地方。

roam volume 与逐轴滑移也保留并用于 Explore：被拒绝的轴会清空对应速度，允许另一轴
继续滑墙；离开后沿已验证 breadcrumbs 返回 tour pose，而不是穿过建筑走直线。自动
tour 的 authored stops 保持不变，运行时通过同一 occupancy 补 safe vias；生产
`getPointAt` 曲线按不大于 1/4 cell 的间距全程验证可漫游。

---

## 4 · 输入仲裁与状态机（已实施）

最终由纯逻辑 `InteractionRouter` 独占仲裁；校准、UI 与 Gaussian 场景不会同时消费同一
只手。生产状态机为：

```text
CALIBRATION
  └─ 只允许校准采样；DOM 与场景输入关闭

NONE
  └─ fresh owner + 明确张手 ──→ POINTING（neutral-armed）

POINTING
  ├─ showreel + scene ready + fresh OPEN + 非 UI ──→ 自动 EXPLORE session
  ├─ confirmed close 落在 UI 控件或可滚动内容 → UI_PRESS（锁定 target / scroll recipient）
  └─ close / unknown / UI hover in showreel ──→ scene HOLD（不建立背景抓取）

EXPLORE（Showreel 专用，session-scoped）
  ├─ fresh OPEN + 非 UI ──→ 中心 joystick 连续 yaw + forward/back
  ├─ UI / close / unknown ──→ HOLD；手仍在时不回 tour
  └─ 丢手 / stale / 换 owner / 离开 showreel ──→ CANCELLED → breadcrumb RETURN

UI_PRESS
  ├─ 位移过阈且可滚动   ──→ UI_SCROLL
  ├─ 未移动 + 主动张手 + target 仍有效 ──→ 一次 click → POINTING
  └─ 取消 / 丢手 / stale / 换 owner / target 失效 ──→ 无点击

UI_SCROLL
  ├─ 主动张手 ──→ POINTING（无点击）
  └─ 丢手 / stale / 换 owner / 超时 / 模式切换 ──→ CANCELLED，立即停止
```

捕获优先级、一次操作一次接收者、`Unknown ≠ Open`、`TrackingLost ≠ Released` 都已成为
router 的可测试契约。每个会话保存 `sessionId`、`ownerId`、起始时间、freshness、冻结 aim、
live origin、raw scene origin、目标和结束原因；display loop 的 watchdog 与 decoded-frame
观测都能走同一取消路径。

---

## 5 · 模块划分：最终落地文件

v1 的职责边界保留了，但实现按可测试性拆成以下生产链：

| 职责 | 最终文件 | 运行契约 |
|---|---|---|
| decoded-frame validation | `lib/vision/videoFrameSource.ts` | unique frame `seq`、source freshness、stale/ended/hidden lifecycle |
| stable active owner | `lib/vision/handOwner.ts` | 临时 owner 轨迹；短暂缺失时保留归属，绝不让数组顺序接管会话 |
| mapping + calibration math | `calibration.ts`, `reachFit.ts`, `profile.ts`, `profileStore.ts` | v4 camera+display installation profile、2.7×1.8/drop2.2 face-width mapping、五方向 reach 与 mapped-zone proof；不持久化 visitor 数据 |
| posture + durable edges | `lib/vision/handPointer.ts` | wrist 指向；毫秒制 `open/closed/unknown`；press/release/cancel queue；UI/raw scene 两套坐标 |
| runtime stability | `lib/vision/pointerStabilizer.ts`, `controlFreshness.ts`, `faceOwner.ts` | owner-scoped 静止死区、自适应结果有效期、与当前 hand owner 关联的 face ruler |
| session + exclusive routing | `lib/vision/interactionRouter.ts` | locked owner/recipient、CALIBRATION/UI/SCENE 互斥、统一取消路径 |
| scene boundary | `lib/vision/flightInput.ts` | 发布获授权的 session/owner/seq/fresh Explore intent；`sceneExploreAxes` 统一校准中心坐标 |
| Gaussian camera math | `experiments/spark/sceneNavigation.ts` | centred joystick、deadzone/acceleration、turn/travel velocity、collision 与 breadcrumb return |
| browser effects | `components/HandControl.tsx` | 唯一生产 consumer；执行 DOM click、scroll 与 scene actions |

“新增只有三个模块”是实施前对文件数量的估计，不是最终结构：frame source、owner、router
和 scene navigation 最终各自成为纯逻辑边界。这样避免把设备生命周期、交互事务和相机
数学重新揉回一个循环，也让三个离线 harness 都直接调用生产代码。

---

## 6 · 验收：挂到真实的 harness 上

v1 §11 的门槛保留，但必须说清在哪里跑，否则没人会跑。仓库现有三个确定性核心
harness，另有版面 user test 与录制数据审计：

| 命令 | 是什么 | 本方案怎么用 |
|---|---|---|
| `npm run check:pointer` | 合成视觉结果 + 虚拟时钟驱动真实 pointer、owner、profile 数学 | 帧去重、freshness、归属、姿态、durable edge 与校准 schema 回归 |
| `npm run check:interaction` | 纯 router 的确定性事务测试 | 独占路由、锁定目标、快速 press/move/release、neutral re-arm 与所有 cancel 原因 |
| `npm run check:scene` | 纯 Gaussian 相机控制测试（34 项） | Explore 中心死区、连续 turn/travel、碰撞/滑墙、安全返回、30/120Hz 等价、内部 LOOK/MOVE 与生产同构 spline 的全巡游 takeover invariant |
| `npm run usertest:home` | 75 点覆盖网格、生产默认握拳、五个栏目往返与四条屏幕边缝 | 版面或点击策略改动后跑 |
| `npm run usertest:enter` | 真实浏览器连续 gesture epoch | Showreel Enter → Home/People → Back → Home/Research，逐拳验证 held 零点击、`None` 松拳恰好点击一次并可连续重置 |
| `node scripts/vision-audit.mjs` | 离线指标；`--fixture` 跑归档数据 | pinch 消融用 |

下列当时要求新增的回归现在分别归入 pointer / interaction / scene harness，而不是全部
塞进 `check:pointer`：

1. **手消失后飞行意图当帧归零**——直接钉死 §1.1 那 1221ms，防止回归。
2. **Explore 舒适中心保持静止；左右偏移连续转向，上下偏移前后移动**。
3. **相同 Explore 输入在 30Hz / 120Hz 下得到等价 turn/travel**。
4. **UI、握拳、unknown 立即 hold；丢手不沿旧速度继续，并只沿 breadcrumbs 回程**。
5. **一次操作跨越目标不改变接收者**（抓取时锁定，释放时不重选）。
6. **位移超阈后即使移回中心也不再点击**。
7. **同一个 `seq` 被消费两次不产生两倍转角**——钉死 §3.6。

v1 §11 表格里的数值门槛（停止性 p95 ≤ 200ms、跟随延迟 p95 < 150ms、点击首次成功率 ≥95%、意外导航 0 次、80% 新用户 60 秒内完成、性能同时报 p50/p95）✅ 全部保留，并保留 v1 自己的免责说明：**这些是待测门槛，不是已有实验结果**，必须结合基线调整。

⚠️ 补一条 v1 没有的：**每个门槛都要有配对的基线**。"改后 p95 是 180ms"没有意义，除非同时有"改前是多少"。现状的数字一个都还没测过。

---

## 7 · 实施顺序

v1 §10 的四阶段✅ 采纳，按本版结论重排：

> **进度（2026-09-17）**：阶段 0–C 已完成。硬编码帧宽、重复帧、无首帧却
> running、陈旧飞行、unstable owner、事件丢边、UI/scene 冲突均已在统一链路处理。
> 校准也已从 sweep/屏幕角点版本重做为 v4 安装 profile：五个舒适轴向停留、配置手势
> 三次、mapped broad zones 验证；默认 fist，visitor 的手型与噪声不写入 profile。
> 阶段 D 的跨真实笔记本/外接显示器陌生用户测量仍是部署前工作，不能由合成测试替代。

**阶段 0 — P0 修复（不改任何交互）**
§1.1 手离开后继续飞、§1.2 三条应用层故障、§1.3 解码样本毫秒门、§1.6 只推理新解码帧。
退出条件：`check:pointer` 全绿 + 新增用例 1 通过；HUD 报出真实分辨率与推理帧率；离开画面后画面立即静止。

**阶段 A — 观测与归属**
最终文件为 `videoFrameSource.ts` + `handOwner.ts` + `faceOwner.ts` +
`controlFreshness.ts`。临时、匿名、易失的轨迹匹配使用 wrist 距离、尺度连续性，左右手
标签只作线索而非 ID；脸尺与 hand owner 关联；活跃操作期间不换归属，歧义时停止而非
强行切换。有效期跟随设备真实产出节奏，而不是用一台开发机的固定帧数。
退出条件：丢手、换手、跨控件拖动都不会触发意外导航。

**阶段 B — 相机数学先离线验证**
最终由 `HandControl` 的互斥接管 + `flightInput.ts` + `sceneNavigation.ts` 承担 session 与
自动 Explore，用合成意图轨迹先证明相同输入在不同渲染/推理频率下产生相同结果。
退出条件：相机逻辑完全不依赖手势是否识别成功。

**阶段 C — 最小语法上线**
Showreel 自动 Explore + UI 点击 + 页面速度滚动共享同一 owner/freshness/neutral-arm
边界。UI 优先，握拳不会同时驾驶场景；生产没有 LOOK/MOVE 模式选择。
退出条件：任何一次手势事务只能产生一种动作。

**阶段 D — 陌生用户测试与调参**
6–10 名未参与开发的志愿者，只看界面提示，完成"转身 / 停住 / 回 Home / 打开内容 / 向下滚动"。
若保留了改造前录屏/指标，可把旧“未校准位置→定速”基线与当前“校准中心 joystick”作
配对比较；不要为做 A/B 把已删除的第二套生产控制器重新接回 kiosk。
历史 v2 曾把平移推迟并一度加入显式 MOVE；最终生产改为自动 Explore（连续转向 +
水平朝向前后），没有横移或单独升高。阶段 D 应包含转向、停止、安全前进/后退与碰撞，
但不要求升高。
之后再依次测：更短的抓取确认、One Euro + owner-scoped stabilizer 参数、可选 pinch。
这些都是运行时/代码策略，不写入 v4 安装 profile。最后才谈双手、选点飞行、物体 orbit。

**并行且独立 — pinch 消融**（v1 §7.2）
✅ 完整保留，一字不改：比较 `ratioWorld3D` / `ratioWorld2D` / `ratioPx`；`ratioPx` 必须用真实像素宽高；不预设 2D 更好，比较的是实际误报/漏报与首次成功率而非曲线形状；距离至少含 0.5m 对照与 1 / 1.5 / 2 / 2.5m；不要把 world-landmark 的 z 当作手到相机的绝对距离。
这条与相机改造**没有依赖关系**，可以并行，且它决定的是买哪台摄像头。

---

## 8 · 最小可交付版本（历史决策与最终差异）

**必须包含**：稳定的临时手归属；单一输入管线；scene session 与 UI 互斥；cancel 与
release 分离；**校准中心驱动的自动 Explore**；页面点击与速度滚动；大而不重叠的 Home
区；失去有效观察即停止；单一相机写入者；自动导览平顺交接。

⚠️ **历史 v2 曾移出**：“显式连续移动、三轴平移可达”，之后又短暂实现 LOOK/MOVE
切换。最终交付删除这两个生产模式，用一个自动 Explore 提供连续转向与沿水平 heading
的前后移动；仍不提供横移或独立升降。

⚠️ **历史中间版曾移入**：短促、有上限、四条守卫保护的 LOOK 释放惯性。最终 Explore
以开放手中心 joystick 连续驾驶，UI/闭手立即 hold，因此生产不使用该惯性。

**仍然不包含**：强制双手；扩充手势词典；单目绝对手深度驾驶；全局 dwell 点击；长时间镜头惯性；从任意高斯像素直接瞬移；整体迁移另一个演示仓库。

---

## 9 · 这份文档没有解决的问题

诚实清单，避免它被当成比实际更确定的东西：

1. **所有性能与延迟数字都还没测过。** §6 的门槛是目标，不是结果。唯一有实测数字的是 §1.1 的 1221ms。
2. **距离仍未测量。** 归档里每一次试验都在 0.5m（见 `docs/vision-audit.md` §6），1–2.5m 区间没有任何数据。摄像头采购卡在这上面，本方案不改变这一点。
3. **Explore 的方向、中心死区、turn/travel 增益仍需陌生用户测。** 开发者已知映射，
   不能代表第一次看到屏幕的路人。
4. **Explore 与完整巡游接管已离线验证，视觉体验仍需实机验收。** 代码已有
   roam-volume 碰撞、breadcrumb 返回与 safe-tour 全路径 invariant；仍要在最终 Gaussian
   资产和各种显示比例上确认不会出现空洞、按钮遮挡或令人迷失的返回路径。
5. **v4 profile 的结构与纯逻辑已固定，真实设备矩阵还需验收。** 至少覆盖内置摄像头+
   笔记本屏、内置摄像头+外接屏、不同 DPR/方向以及慢速笔记本；确认 pairing 切换会重跑、
   五个 mapped broad zones 都可舒适到达、静止 wrist 不抖且缓慢移动不会被死区吞掉。
