'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { apiFetch } from '@/lib/api-fetch';

interface TTSOptions {
  lang?: string;
}

export function useTTS(options: TTSOptions = {}) {
  const [speaking, setSpeaking] = useState(false);
  const [supported] = useState(true);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cleanupAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      cleanupAudio();
      abortRef.current?.abort();
    };
  }, [cleanupAudio]);

  const speak = useCallback(async (text: string, agentId?: string) => {
    cleanupAudio();
    abortRef.current?.abort();
    abortRef.current = null;
    window.speechSynthesis?.cancel();

    // Clean text
    const clean = text
      .replace(/[#*_~`]/g, '')
      .replace(/\[.*?\]/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, '. ')
      .slice(0, 2000)
      .trim();

    if (!clean) return;

    setSpeaking(true);

    try {
      // Try Edge TTS API first (natural voice)
      const controller = new AbortController();
      abortRef.current = controller;

      const res = await apiFetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: clean,
          agentId: agentId || '',
          lang: options.lang?.startsWith('en') ? 'en' : 'ko',
        }),
        signal: controller.signal,
      });

      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioUrlRef.current = url;
        audioRef.current = audio;

        audio.onended = () => {
          setSpeaking(false);
          cleanupAudio();
        };
        audio.onerror = () => {
          setSpeaking(false);
          cleanupAudio();
        };

        await audio.play();
        return;
      }
    } catch (err) {
      cleanupAudio();
      if ((err as Error)?.name === 'AbortError') {
        setSpeaking(false);
        return;
      }
      // Fall through to Web Speech API
    }

    // Fallback: Web Speech API
    if ('speechSynthesis' in window) {
      const utter = new SpeechSynthesisUtterance(clean);
      utter.lang = options.lang || 'ko-KR';
      utter.rate = 1.0;

      const voices = window.speechSynthesis.getVoices();
      const preferred = voices.find(v => v.lang.startsWith('ko') && v.name.includes('Google'))
        || voices.find(v => v.lang.startsWith('ko'));
      if (preferred) utter.voice = preferred;

      utter.onend = () => setSpeaking(false);
      utter.onerror = () => setSpeaking(false);
      window.speechSynthesis.speak(utter);
    } else {
      setSpeaking(false);
    }
  }, [cleanupAudio, options.lang]);

  const stop = useCallback(() => {
    cleanupAudio();
    abortRef.current?.abort();
    abortRef.current = null;
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }, [cleanupAudio]);

  return { speak, stop, speaking, supported };
}
