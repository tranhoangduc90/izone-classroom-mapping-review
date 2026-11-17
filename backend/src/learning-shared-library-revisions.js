import {FormAuthoringError} from './learning-form-authoring.js';

export const sharedLibraryCurrent=entry=>`NOT EXISTS (
  SELECT 1 FROM learning.form_shared_library_item item
  WHERE (item.id=${entry} OR item.id=(SELECT revision.item_id FROM learning.form_shared_library_revision revision WHERE revision.published_entry_id=${entry}))
  AND (item.current_entry_id<>${entry} OR item.archived_at IS NOT NULL))`;

export function assertSharedLibraryCurrent(entryId,item){
  if(item?.archived_at)throw new FormAuthoringError('CATALOG_ARCHIVED','Bài đã bị xóa khỏi Kho chung.',[],409);
  if(item&&item.current_entry_id!==entryId)throw new FormAuthoringError('LIBRARY_SOURCE_STALE','Bài đã có phiên bản mới. Hãy mở lại từ Kho chung.',[],409);
}

export async function sharedLibraryItem(database,entryId){
  const {rows}=await database.query(`SELECT item.* FROM learning.form_shared_library_item item
    WHERE item.id=$1::uuid OR item.id=(SELECT item_id FROM learning.form_shared_library_revision WHERE published_entry_id=$1::uuid)`,[entryId]);
  return rows[0];
}

export async function assertSharedPublicationCurrent(database,publication,origin){
  const candidates=(await database.query(`SELECT entry.id,item.current_entry_id,item.archived_at
    FROM learning.form_shared_library_item item
    JOIN learning.form_library_entry entry ON entry.id=item.id OR entry.id IN (
      SELECT published_entry_id FROM learning.form_shared_library_revision WHERE item_id=item.id AND published_entry_id IS NOT NULL)
    WHERE ($1::uuid IS NULL OR entry.id=$1) AND (
      (entry.id=$2::uuid AND entry.content_hash=$3) OR
      (entry.source_draft_id=$4::uuid AND entry.source_revision=$5 AND entry.content_hash=$6) OR
      (entry.public_definition->>'formVersionId'=$7 AND entry.content_hash=$6))`,
  [origin?.libraryId||null,publication.source_library_id,publication.source_content_hash,
    publication.source_draft_id,publication.source_revision,publication.content_hash,publication.form_version_id])).rows;
  for(const item of candidates)assertSharedLibraryCurrent(item.id,item);
}
