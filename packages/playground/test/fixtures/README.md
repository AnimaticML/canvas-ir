`mediapipe-hand.json` is numerical output captured from MediaPipe Hand Landmarker
0.10.32 (float16/1) processing the official MediaPipe test image:
https://storage.googleapis.com/mediapipe-assets/right_hands.jpg

The source image is not included. This fixture checks the actual model's
non-projective metric geometry, rather than assuming perfect synthetic landmarks.
It does not establish physical depth accuracy on a real phone.
