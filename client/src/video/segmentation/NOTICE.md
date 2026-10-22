# Camera background blur: third-party notices

Background blur (Settings › Camera) finds the person in each camera frame with a small neural
network and blurs everything else, on the device, before the video is sent. Nothing here talks
to a server: the files below are bundled with the client and served by it; the camera picture
never leaves the device unblurred while blur is on.

When the camera driver and the operating system offer their own background blur (Chrome's
`backgroundBlur` camera capability, for example Windows Studio Effects), Datasetto switches that
on instead and none of the files below are loaded.

## MediaPipe Selfie Segmentation models (`selfie_segmenter_landscape.tflite`, `selfie_segmenter.tflite`)

- Google's MediaPipe selfie segmentation models, float16, as published for the MediaPipe Image
  Segmenter task:
  - `selfie_segmenter_landscape.tflite` (input 256 x 144, used for 16:9 cameras), 250,177 bytes,
    sha256 `490e9ea734313e0de10fa0cd9e3c6133e36ea4db2b7a49bde9ef019f72796b8e`, from
    https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite
  - `selfie_segmenter.tflite` (input 256 x 256, used for 4:3 and portrait cameras), 249,537 bytes,
    sha256 `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b`, from
    https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite
  - Both files were published on 2023-05-07 and are used unchanged.
- Model card: "Model Card MediaPipe Selfie Segmentation" (Tingbo Hou, Siargey Pisarchyk, Karthik
  Raveendran, Google; May 6, 2021),
  https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf.
  It states: licensed under the Apache License, Version 2.0 (`LICENSE-APACHE-2.0` in this folder).
- Intended use per the model card: human segmentation in interactive video applications such as
  video conferencing. Out of scope: several people at different distances, people further than
  about 4 m from the camera, and any form of surveillance or identity recognition. The card reports
  an average IoU of about 96 % across 17 geographical regions with no region outside its fairness
  criteria.

## MediaPipe Tasks for Vision (`@mediapipe/tasks-vision` 1.1.1)

- The npm package `@mediapipe/tasks-vision` (Google, https://github.com/google-ai-edge/mediapipe),
  version 1.1.1, licensed under the Apache License, Version 2.0 (`license` in its package.json;
  the text is in `LICENSE-APACHE-2.0` here). The client bundles its JavaScript API and serves its
  WebAssembly runtime (`vision_wasm_module_internal.js` and `.wasm`, about 13.5 MB) as separate
  files, loaded only when blur is turned on.
- MediaPipe's WebAssembly runtime embeds TensorFlow Lite and XNNPACK (Apache-2.0 and BSD-3-Clause
  respectively, Google) and their dependencies under their own permissive licences.

## Compatibility

Datasetto is licensed under the GNU AGPL v3. The Apache License 2.0 is compatible with version 3
of the GNU licences, so these files can be distributed with it; their notices and the licence text
stay with them in this folder.
