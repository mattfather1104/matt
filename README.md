# Tank Arena 多人對戰（第一階段）

這是 Tank Arena 的**獨立**多人連線版本，跟原本單機的 `tank_arena.html` 完全分開、互不影響。

現階段刻意簡化，只做到「最多幾個真人在同一個場地裡移動、射擊、互相打」：
- 沒有電腦機器人
- 沒有 2TDM 基地機制
- 沒有升級/加點系統，所有玩家都是同一種固定坦克
- 沒有客戶端預測，操作手感會有一點點網路延遲感（未來可以再優化）

## 本機測試（需要先安裝 Node.js，18版以上）

```bash
npm install
npm start
```

然後在瀏覽器打開 http://localhost:3000 ，可以開多個分頁模擬多個玩家測試。

## 部署到 Render.com（免費方案）

1. 把這整個 `tank_arena_multiplayer` 資料夾推到一個 GitHub repo（可以是 private）。
2. 到 https://render.com 用 GitHub 帳號登入，選 "New +" → "Web Service"。
3. 選你剛剛推上去的 repo。
4. 設定：
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. 部署完成後，Render 會給你一個網址，例如 `https://tank-arena-xxxx.onrender.com`。
6. 把這個網址分享給朋友，大家打開同一個網址就會進到同一場對戰。

**注意**：免費方案閒置約15分鐘會自動休眠，下次有人打開連結時，第一個連線的人可能要等 30~60 秒讓伺服器重新啟動。

## 操作方式
- WASD：移動
- 滑鼠：瞄準方向
- 滑鼠左鍵（按住）或空白鍵：開火
