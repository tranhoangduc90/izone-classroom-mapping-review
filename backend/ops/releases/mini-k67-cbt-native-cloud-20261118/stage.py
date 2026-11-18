"""Build a Mini K67 CBT journal overlay from the pinned API runtime."""
from argparse import ArgumentParser
from hashlib import sha256
from pathlib import Path
from shutil import copytree
import json


BASE_ADAPTER = "de1c1800a0e65ecc460ae6c4c344c619085e3a2750b40975ddcc8d1f9a0a04d6"
RELEASE = Path(__file__).resolve().parent
ADAPTER = Path("adapters/term.mjs")
MODULES = Path("adapters/mini-cbt")


def patch_adapter(source):
    if sha256(source).hexdigest() != BASE_ADAPTER:
        raise ValueError("Mini K67 runtime adapter does not match the reviewed production baseline")
    text = source.decode("utf-8").replace("\r\n", "\n")
    substitutions = (
        (
            "import { mountMiniPaperNativeCloud }",
            "import { mountMiniK67CbtNativeCloud } from './mini-cbt/native-router.mjs';\n"
            "import { mountMiniPaperNativeCloud }",
        ),
        (
            "  if(miniPaperNativeCloud)journal.registerCounters?.('miniPaperNativeCloud',miniPaperNativeCloud.metrics);",
            "  if(miniPaperNativeCloud)journal.registerCounters?.('miniPaperNativeCloud',miniPaperNativeCloud.metrics);\n"
            "  const miniCbtNativeCloud=mountMiniK67CbtNativeCloud({env,productId,schema,query,\n"
            "    scopeForOwner:owner=>journal.scopeForOwner(owner),logger});\n"
            "  if(miniCbtNativeCloud)journal.registerCounters?.('miniCbtNativeCloud',miniCbtNativeCloud.metrics);",
        ),
        (
            "||(miniPaperNativeCloud&&await miniPaperNativeCloud.offer({owner,scope:context,type,data,occurredAt})));",
            "||(miniPaperNativeCloud&&await miniPaperNativeCloud.offer({owner,scope:context,type,data,occurredAt}))\n"
            "        ||(miniCbtNativeCloud&&await miniCbtNativeCloud.offer({owner,scope:context,type,data})));",
        ),
        (
            "miniPaperNativeCloud?.close()]);",
            "miniPaperNativeCloud?.close(),miniCbtNativeCloud?.close()]);",
        ),
    )
    for old, new in substitutions:
        if text.count(old) != 1:
            raise ValueError("Unexpected adapter anchor")
        text = text.replace(old, new)
    return text.encode("utf-8")


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("runtime", type=Path, help="Extracted read-only copy of the live exam-journal-runtime")
    parser.add_argument("output", type=Path, help="New local directory for rehearsal")
    args = parser.parse_args()
    runtime = args.runtime.resolve(strict=True)
    output = args.output.resolve()
    if runtime in output.parents or output.exists() or (runtime / MODULES).exists():
        parser.error("Output must be new and outside the baseline runtime, which must have no existing Mini CBT overlay")
    adapter = patch_adapter((runtime / ADAPTER).read_bytes())
    copytree(runtime, output)
    copytree(RELEASE / "mini-cbt", output / MODULES)
    (output / ADAPTER).write_bytes(adapter)
    hashes = {
        path.relative_to(output).as_posix(): sha256(path.read_bytes()).hexdigest()
        for path in [output / ADAPTER, *sorted((output / MODULES).glob("*.mjs"))]
    }
    print(json.dumps({"baseAdapterSha256": BASE_ADAPTER, "overlay": hashes}, sort_keys=True))


if __name__ == "__main__":
    main()
