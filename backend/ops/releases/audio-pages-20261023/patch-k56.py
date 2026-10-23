"""Patch the exact live order module; fail on an unknown source layout.

Input: live k56-exam-order.js. Output: overlay file for the same runtime image.
Never rebuild K56 from a different main or change the existing start/clock API.
"""
from pathlib import Path
import sys

source,dest=map(Path,sys.argv[1:3])
text=source.read_text(encoding='utf-8-sig')
def replace_once(old,new):
 global text
 if text.count(old)!=1:raise RuntimeError('patch_anchor_not_unique: '+old[:70])
 text=text.replace(old,new,1)

replace_once("import crypto from 'node:crypto';", "import crypto from 'node:crypto';\nimport {selectK56PublicAudio} from './k56-public-audio.mjs';")
replace_once('studentRef: z.string().uuid(), mode: modeSchema,','studentRef: z.string().uuid(), mode: modeSchema, publicAudioVersion: z.literal(1).optional(),')
replace_once('async function withContent(a) {','async function withContent(a, publicAudio = false) {')
replace_once("      response.previewAudioUrl = `/api/term-tests/${a.test_slug}/session/${a.exam_session_token}/preview`;", "      response.previewAudioUrl = `/api/term-tests/${a.test_slug}/session/${a.exam_session_token}/preview`;\n      if (publicAudio) response.audioManifest = await selectK56PublicAudio(pool, a);")
replace_once('...await withContent(a), modeMismatch:', '...await withContent(a, body.publicAudioVersion === 1), modeMismatch:')
replace_once('res.json(a ? await withContent(a) : { ok:true, found:false });','res.json(a ? await withContent(a, body.publicAudioVersion === 1) : { ok:true, found:false });')
dest.parent.mkdir(parents=True,exist_ok=True)
dest.write_text(text,encoding='utf-8')
