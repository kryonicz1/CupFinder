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

  // COCO SSD MobileNet model — input 300x300 uint8, outputs SSD format.
  // COCO uses 80 object categories with non-contiguous IDs spanning 1–90.
  // Cup = class ID 47. We filter for it in the frame processor.
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
  const hasLoggedFirstInference = useRef(false);

  // Log model state changes
  useEffect(() => {
    if (model.state === 'loaded') {
      console.log('[CupFinder] Model loaded successfully');
      console.log('[CupFinder] Inputs:', JSON.stringify(model.model.inputs));
      console.log('[CupFinder] Outputs:', JSON.stringify(model.model.outputs));
    } else if (model.state === 'error') {
      console.error('[CupFinder] Model failed to load:', model.error);
    } else {
      console.log('[CupFinder] Model state:', model.state);
    }
  }, [model.state]);

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
      console.warn('[CupFinder] Haptic playback failed:', e);
    } finally {
      isPlayingRef.current = false;
    }
  }, []);

  // Start a repeating haptic timer for the given pattern.
  // Seeking repeats every 2s; directional patterns repeat every 300ms.
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
      }, 300);
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

  // Log diagnostics from the worklet thread back to JS
  const logFromWorklet = useRunOnJS((msg: string) => {
    console.log(msg);
  }, []);

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

  // Frame processor — runs ML inference on the worklet thread.
  // actualModel is extracted outside the worklet so only the loaded model
  // object (a plain host object, safe to access from the worklet) is captured,
  // not the reactive model.state hook value.
  const frameProcessor = useFrameProcessor((frame) => {
    'worklet';

    if (!actualModel) return;

    runAtTargetFps(10, () => {
      'worklet';

      // Resize frame to model input dimensions
      const resized = resize(frame, {
        scale: { width: 300, height: 300 },
        pixelFormat: 'rgb',
        dataType: 'uint8',
      });

      // Run inference
      const outputs = actualModel.runSync([resized]);

      // Validate we got the expected number of output tensors
      if (outputs.length < 4) {
        logFromWorklet('[CupFinder] ERROR: Expected 4 output tensors, got ' + outputs.length);
        return;
      }

      const boxes = outputs[0];
      const classes = outputs[1];
      const scores = outputs[2];
      const numDetections = outputs[3];

      // Log first successful inference for diagnostics
      if (!hasLoggedFirstInference.current) {
        hasLoggedFirstInference.current = true;
        logFromWorklet(
          '[CupFinder] First inference OK — outputs: ' +
          'boxes[' + boxes.length + '] ' +
          'classes[' + classes.length + '] ' +
          'scores[' + scores.length + '] ' +
          'numDet[' + numDetections.length + '] ' +
          'numDetections=' + numDetections[0] + ' ' +
          'topClass=' + classes[0] + ' ' +
          'topScore=' + scores[0]
        );
      }

      const count = Math.min(Math.round(numDetections[0]), scores.length);

      // COCO class ID for "cup" is 47 (80 categories, non-contiguous IDs 1–90)
      const CUP_CLASS_ID = 47;

      // Find best cup detection above threshold
      let bestScore = 0.4;
      let bestIndex = -1;
      for (let i = 0; i < count; i++) {
        if (Math.round(classes[i]) === CUP_CLASS_ID && scores[i] > bestScore) {
          bestScore = scores[i];
          bestIndex = i;
        }
      }

      if (bestIndex === -1) {
        handleDetection('seeking');
        return;
      }

      // Parse bounding box — SSD format: [ymin, xmin, ymax, xmax] normalized 0–1
      const offset = bestIndex * 4;

      // Validate offset is within bounds
      if (offset + 3 >= boxes.length) {
        logFromWorklet('[CupFinder] ERROR: Box offset ' + offset + ' out of bounds (boxes.length=' + boxes.length + ')');
        handleDetection('seeking');
        return;
      }

      const ymin = boxes[offset];
      const xmin = boxes[offset + 1];
      const ymax = boxes[offset + 2];
      const xmax = boxes[offset + 3];

      const width = xmax - xmin;
      const centerX = xmin + width / 2;
      const area = width * (ymax - ymin);

      // Determine distance: area > 15% of frame = near
      const isNear = area > 0.15;

      // Determine pattern based on position and size
      let pattern: HapticPattern;

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
    });
  }, [actualModel, resize, handleDetection, logFromWorklet]);

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
