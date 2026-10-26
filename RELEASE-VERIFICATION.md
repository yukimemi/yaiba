# v0.30.0 公開後の確認

所有者のマージ承認を経て、既存の auto-tag → release ワークフローが
完了した後に実行する。タグは手動で作成しない。

```sh
gh release view v0.30.0 --repo yukimemi/yaiba \
  --json url,isDraft,isPrerelease,assets
gh api repos/yukimemi/yaiba/compare/c012cdb...v0.30.0 \
  --jq '{status, merge_base: .merge_base_commit.sha}'
```

公開済みリリースの `isDraft` と `isPrerelease` がともに `false` で、
比較結果の `status` が `ahead` または `identical` であることを確認する。
これは `gx` を導入した `c012cdb` がリリースタグの祖先または同一コミット
であることの確認になる。

`assets` に次の配布ファイルがすべて存在し、それぞれの `size` が 0 より
大きいことも確認する。GitHub 自動生成のソースアーカイブだけでは完了としない。

- `yaiba-x86_64-unknown-linux-musl.tar.gz`
- `yaiba-aarch64-unknown-linux-musl.tar.gz`
- `yaiba-x86_64-pc-windows-msvc.zip`
- `yaiba-aarch64-apple-darwin.tar.gz`

確認後は取得した `url` と、タグへの `c012cdb` の包含結果、配布アセットの
確認結果を報告する。未公開・比較失敗・アセット不足の場合は確認未完了として
報告し、`gx` を含むリリースが公開済みとは断定しない。
