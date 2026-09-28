#!/usr/bin/env bash
# Dữ liệu nhận vào: database PostgreSQL hiện hành của mapping-review-api.
# Việc chính: sao lưu toàn database trước khi phát hành phiếu thật.
# Kết quả: một bản sao riêng tư và số mục pg_restore đọc được.
# Khi lỗi: dừng phát hành, không ghi đè bản sao cũ hoặc thay đổi database.
set -Eeuo pipefail

backup_dir='/opt/mapping-review-api/backups/progress-log-ic2305-session5-20260928'
backup_file="$backup_dir/before-release.dump"
install -d -m 700 "$backup_dir"
test ! -e "$backup_file"
docker exec mapping-postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup_file"
chmod 600 "$backup_file"
test -s "$backup_file"
entry_count=$(docker exec -i mapping-postgres pg_restore --list < "$backup_file" | wc -l)
test "$entry_count" -gt 100
printf 'backup_verified bytes=%s entries=%s sha256=%s\n' \
  "$(stat -c %s "$backup_file")" "$entry_count" "$(sha256sum "$backup_file" | cut -d ' ' -f 1)"
