# Genesis 簽章服務（R5，免費 Mint）｜2026-10-21

合集為非官方、社群自行推動的 Ember Evo Genesis。這個資料夾是**正式用**簽章服務的程式，但**還沒部署**，目前只在本機測試鏈上驗證過。

## 做什麼
玩家在 Mint 頁選好外觀和顏色後，頁面把 `{wallet, look, choice}` 送來。服務依序處理：
1. 用**共用規則**（`look.mjs`）檢查外觀：零件要在對的欄位、7 條搭配規則要通過、配件不算在內。
2. 讀**鏈上狀態**：簽章者是否是自己、名單 root 是否相符、是否暫停、是否開賣、是否已領過、外觀與顏色是否還能用、顏色是否售完、本批隨機款是否已達 25 枚。
3. 簽 EIP-712 `Appearance`，回傳 `mintFree` 需要的 6 個參數，包含 Merkle proof。

鏈上檢查只是讓玩家少送一筆會失敗的交易，真正做最後決定的仍然是合約。

## 檔案
| 檔案 | 用途 |
|---|---|
| `catalogue-data.mjs` | 由 `tools/gen-catalogue.mjs` 從 Mint 頁的 `parts-data.js`、`rules-data.js` 產生，不要手改。共 86 件（帽 15、上衣 19 含內領 5、背心 5、外套 24、褲 11、鞋 12）。 |
| `look.mjs` | 共用規則：欄位、搭配規則、canonical 字串、lookKey。**之後 Mint 頁也改用這份**，避免兩邊規則不一致。 |
| `free-approval.mjs` | 簽章核心＋免費名單 Merkle tree。 |
| `worker.mjs` | HTTP 介面：限定來源網域、只收 JSON、最大 4 KB、錯誤只回代碼。 |
| `worker-entry.mjs` | Cloudflare Worker 入口；設定從環境變數和機密讀取。 |
| `snapshot-wallets.json` | 免費名單，目前是空的；空的時候服務會拒絕所有請求。 |
| `tests/signer.test.mjs` | 9 項測試，在本機測試鏈部署 R5 合約後做端對端 Mint。 |
| `dev-server.mjs` | 本機試玩伺服器（只在記憶體裡的測試鏈上跑）。 |

## 規格
- **lookKey** = `keccak256("emberevo-genesis-look:v1;body=…;hat=…;top=…;vest=…;outer=…;bottom=…;shoes=…")`，沒選的欄位寫 `none`，`null` 和 `""` 視為相同。顏色不算在外觀裡。
- **choice**：0 綠、1 冰藍、2 紫、3 隨機。粉、橘、金只能透過隨機取得。
- **指定色的 URI** = `METADATA_BASE + lookKey + "/" + choice`，格式和隨機款揭曉後的 URI 一樣。隨機款 URI 是空字串。
- **名單 Merkle**：leaf = `keccak256(keccak256(abi.encode(wallet)))`，地址轉小寫後升冪排序，兩兩配對時排序後雜湊，落單的節點直接升到上一層。擁有者呼叫 `configureSnapshot` 時要用這裡算出的 root。
- **API**
  - `POST /v1/approval/free`
  - `POST /v1/approval/paid`：目前回 501，等 Codex 回覆 GOLD 帳本怎麼串。
  - `GET /v1/health`

## Mint 頁接線（2026-10-21）
- Mint 頁的 `lib/look.mjs`、`lib/catalogue-data.mjs`、`vendor/ethers.min.js` 是從這裡複製過去的（`node signer/tools/sync-page.mjs ../../mint-page`）。有測試確認兩邊逐位元組相同，改了規則一定要重新同步。
- `mint-page/config.js` 預設是 `null`，頁面就只是預覽，跟以前一樣。部署時填入 `{chainId, chainName, contract, signerApi}`，頁面就會進入正式模式：
  - 連接錢包，切到正確網路；
  - 查詢免費資格；
  - 送出免費 Mint，Mint 前先用 staticCall 預跑，失敗時直接顯示原因；
  - 在「我的 Pepe」顯示 Mint 到的 token；
  - 提供「揭曉已到時間的批次」按鈕（呼叫 `settle()`）；
  - 上方的已 Mint 數量會讀鏈上資料。
- 付費按鈕維持關閉，顯示「付費 Mint 之後才開放」。
- 新增的 API：`POST /v1/eligibility`、`GET /v1/stats`。

## Mint 頁付費流程（2026-10-21）
- `config.js` 要設 `paid:true` 才會開放付費，而且只有簽章服務有 GOLD binding 的部署才這樣設。價格直接讀合約的 `paidCost` 和 `paidGoldCost`。
- **流程**：
  1. 簽章服務準備訂單；
  2. EMBEO 授權不夠時，請錢包授權**剛好這次的金額**（不會要求無限授權）；
  3. 錢包簽 GOLD 預扣同意（不花 gas）；
  4. 預扣 GOLD；
  5. 先試跑一次再送出 `mintPaid`；
  6. 完成。
- **重試**：同一張訂單會保留到 Mint 成功為止，這段時間重按都沿用同一張，不會重複預扣，合約也不接受同一張訂單用兩次。訂單過期、已退回或已 Mint 時，才會建立新訂單。
- **不先顯示 GOLD 餘額**：查別人的餘額要先取得本人同意（docs/09）。不夠的話，簽完同意會直接告訴玩家「不夠，沒有預扣也沒有扣款」。
- **本機實測**（dev-server 5193）：
  - 錢包 3 用指定色付費 Mint：鏈上燒掉 300,000 EMBEO，剩下的授權是 0，token 屬於本人；
  - 隨機款付費 Mint 成功；
  - 錢包 2（沒有 GOLD）顯示「GOLD 不夠」；
  - 沒有 config 時仍是預覽模式。

## 本機試玩（不碰任何真實網路）
`node signer/dev-server.mjs` 會開在 http://127.0.0.1:5193/。也可以在 app 的預覽用 `genesis-mint-dev`。
- 它會在記憶體裡起一條測試鏈、部署 R5 合約，然後提供頁面、簽章 API 和開發用錢包。
- `?devwallet=0`、`1`、`2` 在免費名單上，`3` 不在。
- 付費：每個 dev 錢包都有測試 EMBEO；錢包 0、1、3 各有 5 測試 GOLD，錢包 2 沒有，用來看「GOLD 不夠」的情況。需要 `C:\EW-V2` 的 World 副本，沒有的話付費會維持關閉（回 501）。
- 想快轉讓批次可以揭曉：對 `/rpc` 送 `hardhat_mine`。
- 已實測：
  - 指定色 Mint 成功；
  - 同造型改選隨機會被拒；
  - 隨機 Mint 成功後，太早按揭曉會提示「還沒到時間」，快轉之後揭曉成功；
  - 不在名單的錢包有正確提示；
  - 搭配規則不符時不能 Mint；
  - 中英文切換正常。

## 付費路線（2026-10-21）
`paid-approval.mjs`，實際流程分兩步：
1. `POST /v1/paid/prepare {wallet, look, choice}`：
   - 檢查造型規則和鏈上狀態，也就是付費是否已開放、額度、外觀、顏色、隨機批次；
   - 從合約讀出 `paidCost`、`paidGoldCost`、`signerEpoch`，排好整張訂單；
   - 回傳訂單、要給錢包簽的「Ember World GOLD」同意（EIP-712，不花 gas），以及一張 HMAC ticket，讓簽章服務不必自己存訂單。
2. `POST /v1/approval/paid {order, uri, ticket, consentSignature}`：
   - 先檢查 ticket 和同意簽章；
   - 透過 service binding `GOLD` 呼叫 World 帳本的 `GenesisGold.reserve`；
   - 帳本回 `held` 之後，才簽 R5 的 `Appearance` 和 `PaidAuthorization`，回傳 `mintPaid` 需要的 9 個參數。
   - 同一張訂單重送是安全的：帳本直接回原本那筆預扣，簽章是確定性的，回傳結果完全一樣。

要開啟付費路線，Worker 必須有 `GOLD` binding、`GOLD_DEPLOYMENT_ID` 和 `TICKET_SECRET`，缺一個就回 501。Sepolia 的設定在 `wrangler.sepolia.toml`，binding 指向 `imd-world-gold-sepolia`，**不是**正式的 `imd-world`。

付費路線另外有兩個選填變數（Swarm audit e9fc751f）：

| 變數 | 格式 | 說明 |
|---|---|---|
| `PAYMENT_TOKENS` | 逗號分隔的代幣地址，例如 `0xAAA…,0xBBB…` | 簽章服務只替這些代幣開單。沒設＝鏈上能用的代幣都開。鏈上的代幣一旦加入就**移不掉**，所以這是停用某個代幣（例如 USDC 收款地址被凍結、imdUSD v1 換成 v2）的唯一開關。設了但是空的，或有一個地址格式錯，付費路線每次都回 500 `CONFIG_PAYMENT_TOKENS`。 |
| `PAID_TTL_SECONDS` | 120–900 的整數，預設 600 | 訂單從 prepare 到 deadline 的秒數。World 帳本最多接受 900。超出範圍回 500 `CONFIG_TTL`。 |

`PAYMENT_TOKENS` 在 prepare 和 approve 兩步都檢查：改掉之後，之前開的單（還沒過 deadline 的 ticket）和重送的 approve 都會被拒絕（`PAYMENT_TOKEN_UNAVAILABLE`），不會預扣 GOLD，也不會簽章。已經預扣的 GOLD 照常在 deadline 後由帳本退回。要讓舊 ticket 連 prepare 的結果都作廢，可以同時換 `TICKET_SECRET`（換了之後所有還沒 approve 的單都要重開）。

**測試**：`tests/paid.test.mjs` 有 4 項，用真實 R5 合約，在 chainId 11155111 的本機鏈上，搭配 World 帳本（`C:\EW-V2` 的副本，包含 9001）。涵蓋：
- 指定色和隨機都能 Mint，finalized 對帳後只扣一次 GOLD，EMBEO 確實被燒掉；
- 沒用到的訂單要等鏈上時間過了 deadline 才退回；
- 訂單被改過、用了別人的同意、GOLD 不足、Mint 暫停時，都在簽章前就被拒絕。

另外做了變異測試：把讀取器的事件簽名故意改錯，兩項扣除測試就會失敗，證明讀取器真的解析了合約實際發出的事件。

## 跑測試
```
node --test --test-concurrency=1 signer/tests/signer.test.mjs
```

## 上線前還缺的
1. ~~合約只能在本機鏈跑~~：已改，現在可以上測試網，主網會被拒絕。步驟見 `RUNBOOK_SEPOLIA_2026-10-21.md`。
2. **免費名單**：名單和快照時間還沒定。
3. **metadata 放哪裡**：還沒定（`METADATA_BASE`）。
4. **簽章金鑰**：要產生新金鑰，存成 Wrangler 機密；合約端由 owner 走 propose／activate 流程換成這把。
5. **部署位置**：IMD 的新 Cloudflare 帳號（不能放診所那個帳號），加上 rate limiter 綁定。
6. **待擁有者確認**：上衣、褲子可以都不穿嗎？目前照 Mint 頁的現況允許。
7. ~~付費路線~~：已完成，見「付費路線」一節；只剩 Mint 頁的付費流程。

## 多種付款幣、每種幣各自的 GOLD 價格（2026-10-29 更新，以這一節為準）
上面「付費路線」一節寫的是單一付款幣時的流程，以下是更新後的情況：
- **價格**：每枚都是 20 美元。imdUSD v1（部署時的付款幣）1,200 GOLD；USDC 在部署後由 Safe 加入，1,600 GOLD；imdUSD v2 之後再加入，1,200 GOLD。用 imdUSD 付款就是 GOLD 優惠（省 400）。
- **合約**：`addPaymentToken(token, goldCost)` 只有擁有者能呼叫，最多加 2 種，每種只能加一次，加了不能移除或改價格；加入 2 天後才能用。`paymentTokens(token)` 打包了金額（0-127 位元）、GOLD 價格（128-215）、可用時間（216-255）。`mintPaid` 最後多一個 `token` 參數，合約用「實際付款的幣」的 GOLD 價格去核對簽章，所以用 imdUSD 價格預扣的訂單不能改付 USDC。
- **`POST /v1/paid/prepare {wallet, look, choice, token}`**：一定要帶 `token`（買家選的付款幣）。訂單的 `goldCost` 就是這種幣的 GOLD 價格，回傳多一個 `payment:{token, amount, goldCost}`（amount 是該幣自己的單位，例如 20 USDC = 20000000）。幣還沒加入或還在 2 天等待期，回 `PAYMENT_TOKEN_UNAVAILABLE`。
- **`mintPaid` 的參數**：簽章服務回傳 6 個（lookKey、choice、uri、orderId、deadline、goldSignature），頁面再加上 reveals 和 token。
- **World 帳本**：registry 的 `addedTokenGoldCosts` 要列出加入的幣的 GOLD 價格（主網：`['1600']`；v2 跟 imdUSD 同價，不用再加）。主網登記要等 USDC 在鏈上加入後，再從 `paymentTokens(USDC)` 讀回價格填進去。
- **舊的 Sepolia 測試合約**（10/27 部署那個）只有一種幣，新的簽章服務不支援它；測試站要繼續用舊的簽章 Worker，新的跟新合約一起上線。
- **測試**：`tests/paid.test.mjs` 現在有 6 項。帳本程式用 World 的 `feature/genesis-gold`（`D:\EmberWorld_rebuild\...\genesis-gold-source`，可用環境變數 `WORLD_BOOK` 指定），測試 GOLD 的種子資料和 9001 仍取自 Sepolia 副本（`D:\A\Desktop\Claude\EW-V2-gold-sepolia\source`，`WORLD_SOURCE` 可改）。USDC 用跟 imdUSD 不同的 GOLD 價格，從預扣到鏈上對帳完整跑過一次。
- **本機 dev-server**：registry 項目已補上 `domainVersion`、`recipient`、`addedTokenGoldCosts`。
