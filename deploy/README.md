# EC2 デプロイ構成（test-kakita-nb-tool）

社内AWS検証環境で稼働する PJ Board の構成メモ。2026-08-24 構築。

## 構成

| 項目 | 値 |
|---|---|
| インスタンス | `test-kakita-nb-tool`（t3.micro / Amazon Linux 2023） |
| VPC / サブネット | NetBox検証系と同じ（vpc-0113020f… / subnet-0b85121a…） |
| キーペア | `auto_g`（NetBox1号機と同じ） |
| SG | `test-kakita-nb-tool`: 22・8100 を社用IPからのみ許可 |
| IP | パブリックIP（変動。再起動で変わる点はNetBox検証機と同運用） |
| アプリ | `/opt/pjboard`（このリポジトリのclone）・systemd `pjboard.service`・ポート8100 |
| データ | `/opt/pjboard/data/`（gitignore対象。構築時にローカルからスナップショット移行済み） |

## 自動デプロイ（GitHubプッシュ → 自動反映）

EC2側ポーリング方式。`pjboard-deploy.timer`（systemd）が**1分ごと**に
`/usr/local/bin/pjboard-deploy.sh` を実行:

1. `git fetch origin main` → ローカルHEADと比較
2. 差分があれば `git reset --hard origin/main` → `pip install -r requirements.txt` → `systemctl restart pjboard`
3. ログ: `/var/log/pjboard-deploy.log`

**main にプッシュするだけで、最大1分ほどでEC2に反映される。**

## 運用コマンド（SSH: `ssh -i auto_g.pem ec2-user@<PublicIP>`）

```
sudo systemctl status pjboard            # アプリ状態
sudo journalctl -u pjboard -f            # アプリログ
sudo tail -f /var/log/pjboard-deploy.log # デプロイログ
sudo /usr/local/bin/pjboard-deploy.sh    # 手動デプロイ（即時反映したいとき）
sudo systemctl restart pjboard           # 手動再起動
cat /var/log/pjboard-bootstrap.log       # 初期構築ログ
```

- DBバックアップはアプリ内蔵の日次ジョブが `/opt/pjboard/data/backups/` に7世代保存
- インスタンス再構築時は [ec2-userdata.sh](ec2-userdata.sh) を user-data に指定して起動すればよい
  （`__DATA_PRESIGNED_URL__` はデータ移行用S3署名URL。新規なら該当行のcurlをスキップしても動く）

## 注意

- 社内の自動停止でインスタンスは夜間停止される想定。**起動のたびにパブリックIPが変わる**
  （現在の確認: AWSコンソール or `aws ec2 describe-instances --filters "Name=tag:Name,Values=test-kakita-nb-tool"`）
- リポジトリは**Public**（自動デプロイの認証レス化のため）。機密（DB・添付・IP・顧客名）を
  コミットしないこと（data/ はgitignore済み）
- デバッグ機能（右上のユーザー切替）は検証用途のため有効のまま。本利用に切り替える際は
  `pjboard.service` の `PJBOARD_DEBUG=1` を `0` に変更
