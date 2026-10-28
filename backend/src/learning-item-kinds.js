// Không thêm mặc định vào JSON lịch sử: đọc mode ở câu trước, rồi mới đến phần.
export function effectiveItemKind(item,block){return item.kind??block?.kind??null;}
export function surveyItemIds(definition){return new Set(definition.blocks.flatMap(block=>block.items.filter(item=>effectiveItemKind(item,block)==='survey').map(item=>item.itemVersionId)));}
