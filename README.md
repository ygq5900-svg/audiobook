# 听书 APP

一款支持导入 TXT 小说、自动朗读、定时关闭、续放的听书应用（Cordova/Android）。

## 功能

- 📚 导入 TXT 小说文件（存储在 IndexedDB）
- 🔊 文字转语音自动朗读（TTS），支持语速、音色调节
- ⏱ 定时关闭（10/15/30/45/60/90 分钟预设、自定义、本章结束）
- ▶️ 续放：自动记忆上次阅读位置
- 📖 书架管理：导入、删除、进度显示

## 技术栈

- Apache Cordova 13 + cordova-android 15.1.0
- 前端：HTML5 + CSS3 + 原生 JavaScript
- 存储：IndexedDB（小说文本）+ localStorage（元数据/进度/设置）
- 语音：Web Speech API (SpeechSynthesis)
- 目标平台：Android 7.0+ (minSdk 24, targetSdk 36)

## 构建 APK

```bash
cordova platform add android
cordova build android
```

APK 输出路径：`platforms/android/app/build/outputs/apk/debug/app-debug.apk`

## 项目结构

```
├── config.xml          # Cordova 配置
├── www/
│   ├── index.html      # 应用页面
│   ├── css/index.css   # 样式
│   └── js/index.js     # 核心逻辑
└── .gitignore
```

## 安装使用

1. 将 APK 安装到 Android 手机
2. 打开 APP → 点「+ 导入小说」选择 TXT 文件
3. 点击书籍卡片 → 自动朗读
4. 底部可调语速、音色、定时关闭
