# PaperBridge Connector（Chrome / Edge 浏览器扩展）

像 Zotero Connector 一样，在浏览 **知网（CNKI）、arXiv、IEEE、Nature、ScienceDirect、PubMed、Google Scholar、万方** 等论文网页时，点一下浏览器右上角图标即可选择分类、编辑标签并一键保存到 PaperBridge。

## 10 秒安装步骤（Chrome / Edge）

1. 解压 `PaperBridge-Connector-vX.Y.Z.zip` 到一个固定文件夹（不要删除该文件夹）。
2. 在浏览器地址栏打开：
   - **Edge**：`edge://extensions`
   - **Chrome**：`chrome://extensions`
3. 打开右上角的 **「开发人员模式 / 开发者模式」**，点击 **「加载解压缩的扩展」**，选中刚刚解压出的文件夹即可。
4. 建议点浏览器地址栏右侧的「拼图」图标，把 **PaperBridge Connector** 固定到工具栏。

## 使用说明

- **桌面端模式（默认）**：打开 PaperBridge 桌面客户端后，扩展会自动连接本机 `127.0.0.1:23129`，读取你的多级分类树并实时写入文库。
- **云同步模式**：不开桌面端也能用！在扩展顶部切到 **「云同步」**，填入你的同步服务器地址（例如 `https://your-server:9999`）并登录账号，即可直接读取云端分类树并保存到云端，网页版与桌面端打开即同步出现。
- **关于知网（CNKI）PDF**：扩展会尝试借用当前浏览器已登录的校园网会话附带 PDF；如果知网触发安全验证/滑块，扩展会直接为你保留完整题录和关键词标签，你点一下知网页面的「PDF下载」再把 PDF 拖入 PaperBridge，系统会自动按标题合并到该题录上。
