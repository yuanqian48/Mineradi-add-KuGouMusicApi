# Mineradio

沉浸式音乐播放器，融合天气电台、歌词舞台、粒子视觉和 3D 歌单架。

## 功能特性

- 多音源聚合：网易云音乐 + 酷狗音乐 + QQ 音乐
- 酷狗概念版 / 标准版双平台切换
- 私人 FM（猜你喜欢）
- 热歌榜单 / 新歌速递
- 歌单收藏、创建、编辑（增删歌曲）
- 概念版每日自动领取 VIP
- 桌面歌词 + 动态壁纸
- 3D 粒子视觉 + 歌单架
- 天气电台
- 播客 DJ 支持
- 全局快捷键

## 技术栈

- Electron 42
- Node.js
- Express
- Three.js (3D 渲染)
- GSAP (动画)

## 快速开始

```bash
npm install
npm start
```

## 打包

```bash
# Windows 安装包
npm run build:win

# Windows 免安装版
npm run build:win:dir
```

打包输出在 `dist/` 目录。

## 项目结构

```
Mineradio/
├── server.js          # 后端 HTTP API 服务
├── kugou-core.js      # 酷狗 API 核心（加解密/签名/指纹模拟）
├── desktop/main.js    # Electron 主进程 + IPC handlers
├── public/index.html  # 前端播放器界面
├── build/             # 打包资源
└── docs/              # 项目文档
```

## 致谢

本项目基于以下开源项目：

- **[KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi)** — 酷狗音乐 Node.js API，作者 **Lines**（基于 MakcRe 的项目），提供酷狗 API 调用、加解密和签名算法
- **[Mineradio](https://github.com/XxHuberrr/Mineradio)** — 原始项目，作者 **XxHuberrr**，提供 Electron 桌面播放器框架
- **[NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)** — 网易云音乐 API

## License

MIT
