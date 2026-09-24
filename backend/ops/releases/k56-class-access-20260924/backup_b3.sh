#!/bin/sh
set -eu

# Dữ liệu vào: database K56 riêng trước migration, trong container PostgreSQL cố định.
# Việc chính: chụp archive riêng tư, thử phục hồi vào database tạm và so số hàng.
# Kết quả: đường dẫn backup, SHA-256 và số hàng; không in hồ sơ học viên.
# Khi lỗi: dừng trước migration; database tạm chỉ bị xóa nếu chính script đã tạo.

db_container='izone-k56-demo-k56-demo-db-1'
source_db='izone_mapping_k56_ic2264'
backup_parent='/opt/backups'
umask 077

test "$(docker inspect izone-k56-ic2264-api --format '{{.Config.Image}}')" = \
  'izone-k56-live-results:20260920.1-teacher-session'
test "$(docker inspect izone-k56-ic2264-api --format '{{.Image}}')" = \
  'sha256:2a00b0bf3593ebb15214cf30d2d1b9df1d84354a541c1841c093438a51bd1f8e'
docker exec "$db_container" pg_dump --version >/dev/null
test -d "$backup_parent"

db_counts() {
  docker exec -e CHECK_DB="$1" "$db_container" sh -lc \
    'psql -U "$POSTGRES_USER" -d "$CHECK_DB" -A -t -F "|" -c \
      "SELECT (SELECT count(*) FROM mapping.classroom_course_mapping), \
              (SELECT count(*) FROM assessment.term_test_roster)"'
}

before_counts="$(db_counts "$source_db")"
test -n "$before_counts"
backup_dir="$(mktemp -d "$backup_parent/k56-class-access-b3-XXXXXXXX")"
case "$backup_dir" in "$backup_parent"/k56-class-access-b3-*) ;; *) exit 2 ;; esac
archive="$backup_dir/izone_mapping_k56_ic2264-before-b3.dump"
test ! -e "$archive"

docker exec "$db_container" sh -lc \
  'exec pg_dump -U "$POSTGRES_USER" -d izone_mapping_k56_ic2264 \
    -Fc --no-owner --no-acl' > "$archive"
test -s "$archive"
docker exec -i "$db_container" pg_restore -l < "$archive" >/dev/null

suffix="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
restore_db="k56_b3_restore_$suffix"
case "$restore_db" in k56_b3_restore_????????????) ;; *) exit 2 ;; esac
restore_created=0
cleanup() {
  if [ "$restore_created" -eq 1 ]; then
    docker exec -e RESTORE_DB="$restore_db" "$db_container" sh -lc \
      'dropdb -U "$POSTGRES_USER" "$RESTORE_DB"' >/dev/null
  fi
}
trap cleanup EXIT HUP INT TERM

docker exec -e RESTORE_DB="$restore_db" "$db_container" sh -lc \
  'createdb -U "$POSTGRES_USER" "$RESTORE_DB"'
restore_created=1
docker exec -i -e RESTORE_DB="$restore_db" "$db_container" sh -lc \
  'pg_restore -U "$POSTGRES_USER" -d "$RESTORE_DB" \
    --no-owner --no-acl --exit-on-error' < "$archive"
restored_counts="$(db_counts "$restore_db")"
test "$restored_counts" = "$before_counts"
test "$(db_counts "$source_db")" = "$before_counts"

archive_sha="$(sha256sum "$archive" | cut -d ' ' -f1)"
printf 'BACKUP_VERIFIED|%s|%s|%s\n' "$archive" "$archive_sha" "$restored_counts"
