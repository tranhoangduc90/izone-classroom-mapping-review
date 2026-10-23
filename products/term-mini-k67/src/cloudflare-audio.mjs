// Native authorization runs before this pure, additive transport decoration.
// Unknown pinned MP3/IZTT1 versions keep their original route and bytes.
const catalog = {
  "93a3901c37fb37a8eb2ec989ef8d382810d4dc99e6b6506a8377fac68dc756ab": {
    "url": "https://tranhoangduc90.github.io/izone-ai-team-pages/term-tests/k56-audio-assets/mini-test-k56-93a3901c37fb37a8.mp3",
    "byteLength": 2228297
  },
  "c7766f97758ec5ecdd3b69dfd3f762567a50bdbb0fd38930a2b609879e8439fc": {
    "url": "https://tranhoangduc90.github.io/izone-ai-team-pages/term-tests/k56-audio-assets/term-test-1-k56-c7766f97758ec5ec.mp3",
    "byteLength": 29559371
  },
  "3600563c0af62fd5c9656be0d7b7f52a1bae281d6af1de80ba4fe0de523f92af": {
    "url": "https://tranhoangduc90.github.io/izone-ai-team-pages/term-tests/k56-audio-assets/term-test-2-k56-3600563c0af62fd5.mp3",
    "byteLength": 29173785
  },
  "182526cd0c3357a4b963ea1cf84a9b72a9a6f6d968324c8905895bcce74088cd": {
    "url": "https://tranhoangduc90.github.io/izone-ai-team-pages/term-tests/k67-audio-assets/mini-test-lesson-5-128kbps-182526cd0c3357a4.mp3",
    "byteLength": 15553581
  },
  "9af027eaaf402acc230fdaeff11bcc1b792b62e55d75067f1a2bcf2392b485f8": {
    "url": "https://tranhoangduc90.github.io/izone-ai-team-pages/term-tests/k67-audio-assets/term-test-1-128kbps-9af027eaaf402acc.mp3",
    "byteLength": 27757131
  },
  "656921dc9888dcfe778eb0cfa6b61491fd906500edde28054d53d26194df219e": {
    "url": "https://tranhoangduc90.github.io/izone-ai-team-pages/term-tests/k67-audio-assets/term-test-2-96kbps-656921dc9888dcfe.mp3",
    "byteLength": 22119070
  },
  "b0220f6be93db9e2ddc28f3debd48d86f81c6b69c809f12a4c1135bee08afacc": {
    "url": "https://tranhoangduc90.github.io/izone-ai-team-pages/listening-practice/audio-assets/inclusive-design-b0220f6be93db9e2.mp3",
    "byteLength": 7781196
  },
  "0454a5b56ce8e7645a5aaa33cfc01be4b1b4fa81de768d20ec5f70bf17d3cfbb": {
    "url": "https://tranhoangduc90.github.io/izone-ai-team-pages/listening-practice/audio-assets/science-experiment-0454a5b56ce8e764.mp3",
    "byteLength": 7347304
  },
  "31c0ccac5841e814e41b0ba31723fbceaafe95c789c8c373ba3c2828a825955d": {
    "url": "https://tranhoangduc90.github.io/izone-ai-team-pages/term-tests/substitute-test-1-k56-computer-based/assets/private/listening-substitute-test-1-k56.mp3",
    "byteLength": 8643188
  },
  "59e69c9691841655a639a22fa9d7a8aec658e4c0c82c5e1451dd5bdd895d0b10": {
    "url": "https://tranhoangduc90.github.io/izone-ai-team-pages/term-tests/substitute-test-1-k67-computer-based/assets/private/listening-substitute-test-1-k67.mp3",
    "byteLength": 8443625
  },
  "45ec0f67301ab0efc16fcf2e5206b23d760a1253badf8d296907c3bfb3f4ef5c": {
    "url": "https://tranhoangduc90.github.io/izone-ai-team-pages/term-tests/substitute-test-2-k56-computer-based/assets/private/listening-substitute-test-2-k56.mp3",
    "byteLength": 8551554
  },
  "3881716311bc53826cbcae5fc7e791b226777c46b438e88637d4d63e9794f0cd": {
    "url": "https://tranhoangduc90.github.io/izone-ai-team-pages/term-tests/substitute-test-2-k67-computer-based/assets/private/listening-substitute-test-2-k67.mp3",
    "byteLength": 41881391
  }
};
export function withCloudflareAudio(manifest,enabled=process.env.AUDIO_CLOUDFLARE_ENABLED==='true') {
  if(!enabled||manifest?.envelopeVersion!=='MP3')return manifest;
  const asset=catalog[manifest.sha256];
  const selection=process.env.AUDIO_CLOUDFLARE_ASSETS?.split(',').map(x=>x.trim()).filter(Boolean);
  if(!asset||asset.url!==manifest.url||asset.byteLength!==manifest.byteLength
    ||selection&&!selection.includes(manifest.sha256))return manifest;
  return {...manifest,cloudflare:{version:1,policy:'public-mp3-v1',chunkSize:524288}};
}
