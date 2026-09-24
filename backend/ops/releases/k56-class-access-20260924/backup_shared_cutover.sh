#!/bin/sh
set -eu

# Dữ liệu vào: hai PostgreSQL container đã xác nhận bằng preflight chỉ đọc.
# Việc chính: backup từng database trước chuyển K56 và thử phục hồi vào DB tạm.
# Kết quả: đường dẫn/hash và số hàng tổng hợp; dữ liệu riêng chỉ nằm trong /opt/backups.
# Khi lỗi: dừng trước migration; DB tạm do chính script tạo sẽ được dọn.
backup_parent='/opt/backups'
shared_container='mapping-postgres'
shared_db='mapping_db'
k56_container='izone-k56-demo-k56-demo-db-1'
k56_db='izone_mapping_k56_ic2264'
umask 077

test -d "$backup_parent"
test "$(docker inspect mapping-review-api --format '{{.State.Health.Status}}')" = healthy
test "$(docker inspect izone-k56-ic2264-api --format '{{.State.Health.Status}}')" = healthy
test "$(docker exec "$shared_container" sh -lc 'printf %s "$POSTGRES_USER"')" = mapping_admin
test "$(docker exec "$k56_container" sh -lc 'printf %s "$POSTGRES_USER"')" = k56_demo_app

backup_dir="$(mktemp -d "$backup_parent/k56-shared-cutover-XXXXXXXX")"
case "$backup_dir" in "$backup_parent"/k56-shared-cutover-*) ;; *) exit 2 ;; esac
shared_archive="$backup_dir/mapping_db-before-k56.dump"
k56_archive="$backup_dir/k56-separate-before-cutover.dump"
restore_shared=''
restore_k56=''
cleanup() {
  if [ -n "$restore_shared" ]; then
    docker exec -e RESTORE_DB="$restore_shared" "$shared_container" sh -lc \
      'dropdb -U "$POSTGRES_USER" "$RESTORE_DB"' >/dev/null
  fi
  if [ -n "$restore_k56" ]; then
    docker exec -e RESTORE_DB="$restore_k56" "$k56_container" sh -lc \
      'dropdb -U "$POSTGRES_USER" "$RESTORE_DB"' >/dev/null
  fi
}
trap cleanup EXIT HUP INT TERM

docker exec "$shared_container" sh -lc \
  'exec pg_dump -U "$POSTGRES_USER" -d mapping_db -Fc --no-owner --no-acl' \
  > "$shared_archive"
docker exec "$k56_container" sh -lc \
  'exec pg_dump -U "$POSTGRES_USER" -d izone_mapping_k56_ic2264 -Fc --no-owner --no-acl' \
  > "$k56_archive"
test -s "$shared_archive"
test -s "$k56_archive"
docker exec -i "$shared_container" pg_restore -l < "$shared_archive" >/dev/null
docker exec -i "$k56_container" pg_restore -l < "$k56_archive" >/dev/null

suffix="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
case "$suffix" in ????????????) ;; *) exit 2 ;; esac
shared_candidate="k56_shared_restore_$suffix"
k56_candidate="k56_source_restore_$suffix"
docker exec -e RESTORE_DB="$shared_candidate" "$shared_container" sh -lc \
  'createdb -U "$POSTGRES_USER" "$RESTORE_DB"'
restore_shared="$shared_candidate"
docker exec -e RESTORE_DB="$k56_candidate" "$k56_container" sh -lc \
  'createdb -U "$POSTGRES_USER" "$RESTORE_DB"'
restore_k56="$k56_candidate"
docker exec -i -e RESTORE_DB="$restore_shared" "$shared_container" sh -lc \
  'pg_restore -U "$POSTGRES_USER" -d "$RESTORE_DB" --no-owner --no-acl --exit-on-error' \
  < "$shared_archive"
docker exec -i -e RESTORE_DB="$restore_k56" "$k56_container" sh -lc \
  'pg_restore -U "$POSTGRES_USER" -d "$RESTORE_DB" --no-owner --no-acl --exit-on-error' \
  < "$k56_archive"

shared_rows="$(docker exec -e RESTORE_DB="$restore_shared" "$shared_container" sh -lc \
  'psql -U "$POSTGRES_USER" -d "$RESTORE_DB" -Atc \
  "SELECT count(*) FROM mapping.classroom_course_mapping"')"
k56_rows="$(docker exec -e RESTORE_DB="$restore_k56" "$k56_container" sh -lc \
  'psql -U "$POSTGRES_USER" -d "$RESTORE_DB" -Atc \
  "SELECT count(*) FROM assessment.term_test_roster"')"
test "$shared_rows" -ge 29
test "$k56_rows" -ge 36

shared_hash="$(sha256sum "$shared_archive" | cut -d ' ' -f1)"
k56_hash="$(sha256sum "$k56_archive" | cut -d ' ' -f1)"
printf 'BACKUP_RESTORE_VERIFIED|%s|%s|%s|%s|%s\n' \
  "$backup_dir" "$shared_hash" "$k56_hash" "$shared_rows" "$k56_rows"
