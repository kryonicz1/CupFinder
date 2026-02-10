import React, { useEffect, useRef, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { Camera, useCameraDevice, useCameraFormat, useCameraPermission, useFrameProcessor, runAtTargetFps } from 'react-native-vision-camera';
import { useTensorflowModel } from 'react-native-fast-tflite';
import { useResizePlugin } from 'vision-camera-resize-plugin';
import { useRunOnJS } from 'react-native-worklets-core';
import * as Haptics from 'expo-haptics';

// Types
type HapticPattern = 'seeking' | 'left_far' | 'left_near' | 'center_far' | 'center_near' | 'right_far' | 'right_near' | 'success';

export default function App() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  const format = useCameraFormat(device, [
    { videoResolution: { width: 1920, height: 1080 } },
    { fps: 30 }
  ]);

  // NOTE: Model input assumed 320x320. Verify with https://netron.app if detections seem wrong.
  // This is a custom cup-only model. If swapping to a multi-class model (e.g. COCO),
  // you must also check outputs[1] (classes) to filter for cup detections only.
  const model = useTensorflowModel(require('./assets/coffee_cup_detector.tflite'));
  const actualModel = model.state === 'loaded' ? model.model : undefined;
  const { resize } = useResizePlugin();

  const patternRef = useRef<HapticPattern>('seeking');
  const foundCupRef = useRef(false);
  const seekingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const retriggerTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastHapticRef = useRef(0);
  const isPlayingRef = useRef(false);
  const successTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Request permission on mount
  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission]);

  // Haptic player with cooldown
  // Pattern encoding: pulse count = direction, intensity = distance
  // Light = far, Medium = near
  const playHaptic = useCallback(async (pattern: HapticPattern) => {
    const now = Date.now();
    if (now - lastHapticRef.current < 400 || isPlayingRef.current) return;

    isPlayingRef.current = true;
    lastHapticRef.current = now;

    try {
      switch (pattern) {
        case 'seeking':
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          break;

        // Left (2 pulses)
        case 'left_far':
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          await new Promise(r => setTimeout(r, 120));
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          break;
        case 'left_near':
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          await new Promise(r => setTimeout(r, 120));
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          break;

        // Center (3 pulses)
        case 'center_far':
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          await new Promise(r => setTimeout(r, 120));
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          await new Promise(r => setTimeout(r, 120));
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          break;
        case 'center_near':
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          await new Promise(r => setTimeout(r, 120));
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          await new Promise(r => setTimeout(r, 120));
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          break;

        // Right (4 pulses)
        case 'right_far':
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          await new Promise(r => setTimeout(r, 120));
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          await new Promise(r => setTimeout(r, 120));
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          await new Promise(r => setTimeout(r, 120));
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          break;
        case 'right_near':
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          await new Promise(r => setTimeout(r, 120));
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          await new Promise(r => setTimeout(r, 120));
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          await new Promise(r => setTimeout(r, 120));
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          break;

        case 'success':
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          break;
      }
    } catch (e) {
      // Haptic failed, non-fatal
    } finally {
      isPlayingRef.current = false;
    }
  }, []);

  // Start a repeating haptic timer for the given pattern.
  // Seeking repeats every 2s; directional patterns repeat every 800ms.
  const startRepeatTimer = useCallback((pattern: HapticPattern) => {
    if (retriggerTimerRef.current) clearInterval(retriggerTimerRef.current);
    if (seekingTimerRef.current) clearInterval(seekingTimerRef.current);

    if (pattern === 'seeking') {
      seekingTimerRef.current = setInterval(() => {
        if (!foundCupRef.current) playHaptic('seeking');
      }, 2000);
    } else if (pattern !== 'success') {
      retriggerTimerRef.current = setInterval(() => {
        if (!foundCupRef.current) playHaptic(patternRef.current);
      }, 800);
    }
  }, [playHaptic]);

  // Cleanup all timers on unmount
  useEffect(() => {
    return () => {
      if (seekingTimerRef.current) clearInterval(seekingTimerRef.current);
      if (retriggerTimerRef.current) clearInterval(retriggerTimerRef.current);
      if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
    };
  }, []);

  // Start seeking heartbeat on mount
  useEffect(() => {
    startRepeatTimer('seeking');
  }, [startRepeatTimer]);

  // Handle detection results from worklet
  const handleDetection = useRunOnJS((pattern: HapticPattern) => {
    if (foundCupRef.current) return;

    if (pattern !== patternRef.current) {
      patternRef.current = pattern;

      if (pattern === 'success') {
        playHaptic(pattern);
        foundCupRef.current = true;
        // Stop directional/seeking timers during success
        if (retriggerTimerRef.current) clearInterval(retriggerTimerRef.current);
        if (seekingTimerRef.current) clearInterval(seekingTimerRef.current);

        successTimeoutRef.current = setTimeout(() => {
          foundCupRef.current = false;
          patternRef.current = 'seeking';
          startRepeatTimer('seeking');
        }, 3000);
      } else if (pattern === 'seeking') {
        startRepeatTimer('seeking');
      } else {
        playHaptic(pattern);
        startRepeatTimer(pattern);
      }
    }
  }, [playHaptic, startRepeatTimer]);

  // Frame processor - runs ML inference on a separate thread.
  // actualModel is extracted outside the worklet so only the loaded model
  // object (a plain host object, safe to access from the worklet) is captured,
  // not the reactive model.state hook value.
  const frameProcessor = useFrameProcessor((frame) => {
    'worklet';

    if (!actualModel) return;

    runAtTargetFps(10, () => {
      'worklet';

      try {
        // Resize frame for model (verify dimensions with Netron if needed)
        const resized = resize(frame, {
          scale: { width: 320, height: 320 },
          pixelFormat: 'rgb',
          dataType: 'uint8',
        });

        // Run inference
        const outputs = actualModel.runSync([resized]);

        // Parse SSD outputs: [boxes, classes, scores, numDetections]
        const boxes = outputs[0] as Float32Array;
        const scores = outputs[2] as Float32Array;
        const numDetections = outputs[3] as Float32Array;

        const count = Math.min(Math.round(numDetections[0]), scores.length);

        // Find best detection above threshold
        let bestScore = 0.6;
        let bestIndex = -1;
        for (let i = 0; i < count; i++) {
          if (scores[i] > bestScore) {
            bestScore = scores[i];
            bestIndex = i;
          }
        }

        if (bestIndex === -1) {
          handleDetection('seeking');
          return;
        }

        // Parse bounding box [ymin, xmin, ymax, xmax]
        const offset = bestIndex * 4;
        const xmin = boxes[offset + 1];
        const xmax = boxes[offset + 3];
        const ymin = boxes[offset];
        const ymax = boxes[offset + 2];

        const width = xmax - xmin;
        const centerX = xmin + width / 2;
        const area = width * (ymax - ymin);

        // Determine pattern based on position and size
        let pattern: HapticPattern;

        // Determine distance: area > 15% of frame = near
        const isNear = area > 0.15;

        // Success: centered and near
        if (centerX > 0.33 && centerX < 0.67 && isNear) {
          pattern = 'success';
        }
        // Direction + distance: divide frame into thirds
        else if (centerX < 0.33) {
          pattern = isNear ? 'left_near' : 'left_far';
        } else if (centerX > 0.67) {
          pattern = isNear ? 'right_near' : 'right_far';
        } else {
          pattern = isNear ? 'center_near' : 'center_far';
        }

        handleDetection(pattern);
      } catch (e) {
        // Inference error, non-fatal
      }
    });
  }, [actualModel, resize, handleDetection]);

  // Loading or error: show black screen
  if (!hasPermission || model.state !== 'loaded' || !device || !format) {
    return <View style={styles.container} />;
  }

  // Main camera view
  return (
    <Camera
      style={StyleSheet.absoluteFill}
      device={device}
      format={format}
      isActive={true}
      frameProcessor={frameProcessor}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
});
