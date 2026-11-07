# 发布到 GitHub

这个目录是一份已经清理过的开源副本：**不含登录态、API key、题库数据**。

## 方式一：网页上传（不用装任何东西）

1. 打开 <https://github.com/new>
2. Repository name 填 `chaoxing-homework`，选 Public，**不要**勾 README / .gitignore / license（本地已经有了）
3. 创建后点「uploading an existing file」，把这个目录里的文件全选拖进去
4. Commit

## 方式二：命令行（推荐，能保留历史）

先装 Git：<https://git-scm.com/download/win>，或 `winget install Git.Git`

```powershell
cd repo

git init -b main
git add .
git commit -m "feat: 学习通作业总览 v1.0"

# 在 GitHub 新建空仓库后，把地址换成你自己的
git remote add origin https://github.com/<你的用户名>/chaoxing-homework.git
git push -u origin main
```

首次 push 会弹出登录窗口，用浏览器授权即可。

## 提交前自查

```powershell
# 不该出现任何个人文件
git status --short
```

只要列表里**没有**下面这些就安全：

- `app/.session.json`（登录 cookie）
- `app/config.json`（API key）
- `app/data/`（题库：作业原文、你的作答）

这三个已经在 `.gitignore` 里，正常不会被 `git add` 进去。
