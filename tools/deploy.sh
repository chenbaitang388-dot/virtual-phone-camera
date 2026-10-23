#!/usr/bin/env bash
# 把本仓库推到一个 GitHub 仓库并开启 GitHub Pages。
# 前提：已经用 `gh auth login` 登录过（脚本会先检查）。
#
# 用法：
#   bash tools/deploy.sh                 # 默认仓库名 virtual-phone-camera
#   bash tools/deploy.sh my-repo-name    # 自定义仓库名
set -euo pipefail

REPO_NAME="${1:-virtual-phone-camera}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v gh > /dev/null 2>&1; then
  echo "找不到 gh。先装：winget install --id GitHub.cli -e"
  exit 1
fi

if ! gh auth status > /dev/null 2>&1; then
  echo "还没登录 GitHub。先跑：gh auth login --hostname github.com --git-protocol https --web"
  exit 1
fi

OWNER="$(gh api user --jq .login)"
echo "登录账号：$OWNER"
echo "目标仓库：$OWNER/$REPO_NAME"

# 1) 仓库不存在就创建（public，因为 Pages 在私有仓库上需要付费计划）
if gh repo view "$OWNER/$REPO_NAME" > /dev/null 2>&1; then
  echo "仓库已存在，直接复用"
else
  echo "创建仓库…"
  gh repo create "$REPO_NAME" --public --description "用真手机陀螺仪遥控浏览器 3D 场景里的虚拟手机，并录制第一人称视频" --disable-wiki
fi

# 2) 本地仓库与 main 分支
if [ ! -d .git ]; then
  git init -q
fi
git symbolic-ref -q HEAD > /dev/null 2>&1 || true

if git show-ref --verify --quiet refs/heads/main; then
  git checkout -q main
else
  git checkout -q -b main
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "有未提交的改动，请先自行提交，脚本不会替你提交"
  git status --short
fi

# 3) 推送
if git remote get-url origin > /dev/null 2>&1; then
  git remote set-url origin "https://github.com/$OWNER/$REPO_NAME.git"
else
  git remote add origin "https://github.com/$OWNER/$REPO_NAME.git"
fi
git push -u origin main --force-with-lease

# 4) 把 Pages 的发布来源设为 GitHub Actions
#    仓库刚建好时 Pages 还没启用，这一步让它启用；已启用则会报 409，忽略即可。
echo "启用 Pages（build_type=workflow）…"
gh api --method POST "repos/$OWNER/$REPO_NAME/pages" \
  -f build_type=workflow > /dev/null 2>&1 \
  || gh api --method PUT "repos/$OWNER/$REPO_NAME/pages" \
       -f build_type=workflow > /dev/null 2>&1 \
  || echo "（Pages 可能已启用，继续）"

# 5) 等部署工作流跑完
echo "等待 GitHub Actions 部署…"
sleep 5
RUN_ID="$(gh run list --repo "$OWNER/$REPO_NAME" --workflow pages.yml --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
if [ -n "$RUN_ID" ] && [ "$RUN_ID" != "null" ]; then
  gh run watch "$RUN_ID" --repo "$OWNER/$REPO_NAME" --exit-status || echo "工作流未成功，去 Actions 页面看日志"
else
  echo "还没看到工作流，稍后可在 Actions 页面查看"
fi

echo
echo "站点地址：https://$OWNER.github.io/$REPO_NAME/"
echo "电脑端：https://$OWNER.github.io/$REPO_NAME/pc.html"
echo "手机端：https://$OWNER.github.io/$REPO_NAME/phone.html"
echo
echo "注意：第一次部署需要几分钟。部署好后用手机打开上面的 /phone.html 时，"
echo "记得先把电脑端页面上显示的 4 位房间号核一遍。"