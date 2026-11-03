# 小鲸鱼快跑 · Little Whale Run

一个零依赖、可直接部署到 Vercel 的横版无尽跑酷游戏。玩法与 Chrome 断网小恐龙 1:1 对齐，视觉主题替换为「小鲸鱼穿越海面岩礁与悬浮礁石」。

## 线上地址

- Vercel：<https://little-whale-run.vercel.app>
- GitHub Pages：<https://xiaojinyi1.github.io/little-whale-run/>

## 运行

```bash
# 任意静态服务器均可
python -m http.server 4173
# 打开 http://127.0.0.1:4173/
```

## 部署

这是一个纯静态站点，**无需 build command**，Vercel 输出目录就是仓库根目录。

```bash
npx vercel --prod
# 或已登录时
vercel deploy --prod
```

### 重新部署与回滚

```bash
npx vercel ls                         # 查看部署列表
npx vercel --prod                     # 重新部署当前目录
npx vercel rollback <deployment-url>  # 回滚生产别名到指定历史部署
npx vercel promote <deployment-url>   # 将指定部署提升为生产
```

### GitHub Pages

仓库根目录包含 `.nojekyll`，GitHub Pages 直接以 `main` 分支根目录发布，无需构建：

```bash
git push origin main
# Settings → Pages → Source: Deploy from a branch → main / (root)
```

首次发布可运行 `bash _qa/github-deploy.sh`（会创建仓库、推送并开启 Pages）。

## 操作

| 输入 | 动作 |
| --- | --- |
| `Space` / `↑` / 点击 / 触屏轻点 | 跳跃（按住更高，松开提前收跳） |
| `↓` / 触屏下滑 | 下潜，穿过悬浮礁石下方 |
| `P` / `Esc` | 手动暂停 |
| 窗口失焦 / 切到后台 | 自动暂停 |

## 目录

```text
.
├── index.html      # 页面骨架、Canvas、暂停按钮、data-URI favicon
├── style.css       # 全屏外壳、安全区、触屏与竖屏提示
├── game.js         # 全部游戏逻辑与 Canvas 绘制（按模块分区）
├── vercel.json     # 纯静态部署配置、缓存与安全响应头
└── _qa/            # 本地验收脚本与截图，不参与部署
```

## 关键实现

### 视口与高清适配

- 逻辑世界 `960 × 540`，`contain` 等比缩放并居中；不裁切左右判定区。
- Canvas 按 `devicePixelRatio`（上限 2.5）设置 backing store，绘制时统一 `scale`。
- 页面 `overflow: hidden`，`touch-action: none`，无横向滚动。

### 物理参数

| 参数 | 值 |
| --- | --- |
| 重力 | `2260 px/s²` |
| 起跳速度 | `-860 px/s` |
| 提前松键速度 | `-620 px/s` |
| 下潜重力 | `720 px/s²`（上限 `1500 px/s`） |
| 长按最大跳高 | 约 `164 px` |
| 轻点最小跳高 | 约 `100 px` |

跳跃为抛物线；`onGround` 为假时忽略再次起跳，落地后才能二段跳。

### 碰撞

- 全部使用 AABB，并对玩家和障碍的碰撞盒统一内缩 `3 px`，避免视觉未接触却判定死亡。
- 站立碰撞盒：`54 × 38`；下潜碰撞盒：`54 × 20`，同时降低身体位置。
- 水面岩礁的碰撞盒贴住海面；悬浮礁石下沿距海面 `34 px`，站立必撞、下潜可过，顶部高度 `188 px`，跳跃无法越过。

### 速度与难度

- 基础速度 `360 px/s`，上限 `780 px/s`；每 100 分增加 `30 px/s`。
- 等价于 60fps 下 `6 → 13 px/frame`、每 100 分 `+0.5 px/frame`。
- 生成间距：`max(300, 410 - (speed - 360) * 0.18)`，并额外保证 `speed * 0.62` 的反应距离，提速后不会生成物理上无法通过的组合。

### 障碍配置

`OBSTACLE_TYPES` 数组驱动，新增障碍只需追加配置：

| id | 类型 | 最小分数 | 通过方式 |
| --- | --- | --- | --- |
| `rock-single` | 单块水面岩礁 | 0 | 跳跃 |
| `rock-double` | 双块水面岩礁 | 55 | 跳跃 |
| `rock-triple` | 三块水面岩礁 | 170 | 跳跃 |
| `overhang-single` | 单块悬浮礁石 | 70 | 下潜 |
| `overhang-double` | 双块悬浮礁石 | 240 | 下潜 |

### 场景与状态

- 海面由多条 `sin` 波叠加绘制，滚动速度低于障碍物形成视差；海面下深蓝色块替代原版土地。
- 远海、云、远山、飞溅水花多层视差。
- 500 分切换「深海夜航」配色，`0.5s` 插值过渡，之后每 500 分昼夜循环。
- 状态机：`READY → RUNNING → GAME_OVER`；暂停是独立布尔状态。
- 分数按距离累加，每 10 分闪一次；最高分保存在 `localStorage` 的 `little-whale-run.best.v1`。
- 重开彻底重置速度、障碍、分数与帧计数。

## 验收工具

```bash
node _qa/verify.mjs   # 交互、视觉、移动端、网络与控制台错误
node _qa/soak.mjs     # 5 分钟连续运行与内存采样
```

`_qa/` 目录已加入 `.vercelignore`，不会进入生产部署。
