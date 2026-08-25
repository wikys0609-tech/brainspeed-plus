import { useState, useEffect, useRef, useCallback } from 'react';
import Papa from 'papaparse';
import { Storage, Screen, SafeArea, Device, TossAds, loadFullScreenAd, showFullScreenAd } from '@apps-in-toss/web-framework';
import './App.css';
import GameRatingInfo from './components/GameRatingInfo';

type ScreenState = 'select' | 'playing' | 'result';
type GameMode = 'quiz' | 'math' | 'geo';

interface QuizItem {
  question: string;
  choice1: string;
  choice2: string;
  choice3: string;
  choice4: string;
  answer: string; // "1" ~ "4"
  category: string;
  difficulty: string;
}

interface GeoQuestion {
  id: string;
  category: string;
  answer_ko: string;
  answer_en: string;
  acceptable_answers: string;
  difficulty: string;
  image: string;
  hint_1: string;
  hint_2: string;
  hint_3: string;
  explanation: string;
}

interface MathProblem {
  question: string;
  answer: number;
}

// TODO: 출시 전 콘솔에서 발급한 실제 광고 ID로 교체
const AD_ID_BANNER = 'ait-ad-test-banner-id';
const AD_ID_REWARDED = 'ait-ad-test-rewarded-id';

// 지리 추론 힌트 사용량 기반 점수 배점 상수
const GEO_SCORE_HINT_0 = 100;
const GEO_SCORE_HINT_1 = 70;
const GEO_SCORE_HINT_2 = 40;
// const GEO_SCORE_HINT_3 = 20; // 첫 힌트가 기본 제공됨에 따라 최대 2회 추가 개방이므로 미사용
const GEO_SCORE_WRONG = 0;

// 피셔-예이츠(Fisher-Yates) 셔플 알고리즘
function shuffleArray<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 빠른 계산 모드 문제 생성 함수
function generateMathProblem(): MathProblem {
  const operators = ['+', '-', '×', '÷'];
  const op = operators[Math.floor(Math.random() * operators.length)];

  switch (op) {
    case '+': {
      const a = Math.floor(Math.random() * 900) + 100; // 100~999
      const b = Math.floor(Math.random() * 900) + 100; // 100~999
      return {
        question: `${a} + ${b} = ?`,
        answer: a + b,
      };
    }
    case '-': {
      const a = Math.floor(Math.random() * 899) + 101; // 101~999
      const b = Math.floor(Math.random() * (a - 100)) + 100; // 100~(a-1)
      return {
        question: `${a} - ${b} = ?`,
        answer: a - b,
      };
    }
    case '×': {
      const a = Math.floor(Math.random() * 90) + 10; // 10~99
      const b = Math.floor(Math.random() * 8) + 2; // 2~9
      return {
        question: `${a} × ${b} = ?`,
        answer: a * b,
      };
    }
    case '÷':
    default: {
      while (true) {
        const isSingleDigit = Math.random() < 0.5;
        const divisor = isSingleDigit
          ? Math.floor(Math.random() * 8) + 2 // 2~9
          : Math.floor(Math.random() * 90) + 10; // 10~99

        const minQuotient = Math.max(10, Math.ceil(100 / divisor));
        const maxQuotient = Math.min(99, Math.floor(999 / divisor));

        if (minQuotient <= maxQuotient) {
          const quotient = Math.floor(Math.random() * (maxQuotient - minQuotient + 1)) + minQuotient;
          const dividend = divisor * quotient;
          return {
            question: `${dividend} ÷ ${divisor} = ?`,
            answer: quotient,
          };
        }
      }
    }
  }
}

// 빠른 계산 모드 4지선다 오답 및 보기 목록 생성 함수
function generateMathChoices(answer: number): string[] {
  const choices = new Set<number>([answer]);

  let attempts = 0;
  while (choices.size < 4 && attempts < 100) {
    attempts++;
    const delta = Math.floor(Math.random() * 41) - 20; // -20 ~ 20
    if (delta === 0) continue;
    const wrong = answer + delta;
    if (wrong > 0) {
      choices.add(wrong);
    }
  }

  if (choices.size < 4) {
    let current = answer + 1;
    while (choices.size < 4) {
      choices.add(current++);
    }
  }

  const shuffledNumChoices = shuffleArray(Array.from(choices));
  return shuffledNumChoices.map((num) => num.toString());
}

// 일반 브라우저 환경(GitHub Pages 등)을 위한 localStorage 폴백이 적용된 안전한 Storage 래퍼
async function safeGetItem(key: string): Promise<string | null> {
  try {
    return await Storage.getItem(key);
  } catch (err) {
    console.warn(`Storage.getItem failed for key "${key}", falling back to localStorage:`, err);
    try {
      return localStorage.getItem(key);
    } catch (localErr) {
      console.error('localStorage.getItem failed:', localErr);
      return null;
    }
  }
}

async function safeSetItem(key: string, value: string): Promise<void> {
  try {
    await Storage.setItem(key, value);
  } catch (err) {
    console.warn(`Storage.setItem failed for key "${key}", falling back to localStorage:`, err);
    try {
      localStorage.setItem(key, value);
    } catch (localErr) {
      console.error('localStorage.setItem failed:', localErr);
    }
  }
}

function App() {
  const [screen, setScreen] = useState<ScreenState>('select');
  const [mode, setMode] = useState<GameMode | null>(null);
  const [score, setScore] = useState<number>(0);
  const [timeLeft, setTimeLeft] = useState<number>(60);

  // 최고 점수 및 신기록 관련 상태
  const [highScoreQuiz, setHighScoreQuiz] = useState<number>(0);
  const [highScoreMath, setHighScoreMath] = useState<number>(0);
  const [isNewRecord, setIsNewRecord] = useState<boolean>(false);

  // 퀴즈 관련 상태
  const [quizzes, setQuizzes] = useState<QuizItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [quizQueue, setQuizQueue] = useState<QuizItem[]>([]);
  const [currentQuiz, setCurrentQuiz] = useState<QuizItem | null>(null);
  
  // 빠른 계산 전용 상태
  const [currentMathProblem, setCurrentMathProblem] = useState<MathProblem | null>(null);

  // 지리 추론 전용 상태
  const [geoQuestions, setGeoQuestions] = useState<GeoQuestion[]>([]);
  const [geoSessionQuestions, setGeoSessionQuestions] = useState<GeoQuestion[]>([]);
  const [geoCurrentIndex, setGeoCurrentIndex] = useState<number>(0);
  const [openedHintsCount, setOpenedHintsCount] = useState<number>(0);
  const [geoInput, setGeoInput] = useState<string>('');
  const [isCorrectGeo, setIsCorrectGeo] = useState<boolean>(false);
  const [showExplanation, setShowExplanation] = useState<boolean>(false);
  const [highScoreGeo, setHighScoreGeo] = useState<number>(0);
  const [imgError, setImgError] = useState<boolean>(false);

  // 공유되는 선택지 상태
  const [shuffledChoices, setShuffledChoices] = useState<string[]>([]);
  const [selectedChoice, setSelectedChoice] = useState<string | null>(null);
  const [isAnswered, setIsAnswered] = useState<boolean>(false);

  // 종료 확인 및 등급 정보 모달 상태
  const [showCloseModal, setShowCloseModal] = useState<boolean>(false);
  const [showInfoModal, setShowInfoModal] = useState<boolean>(false);

  // Safe Area 인셋 상태
  const [safeArea, setSafeArea] = useState({ top: 0, bottom: 0, left: 0, right: 0 });

  // 사운드 활성화 여부 상태
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);

  // 인앱 광고 2.0 관련 상태
  const [hasContinued, setHasContinued] = useState<boolean>(false); // 이어하기 사용 여부
  const [isAdLoading, setIsAdLoading] = useState<boolean>(false);    // 광고 로딩 상태
  const [isAdPlaying, setIsAdPlaying] = useState<boolean>(false);    // 광고 송출 상태 (사운드 중지용)

  // 타이머 실행 시 stale closure 방지용 Ref
  const scoreRef = useRef<number>(0);
  const modeRef = useRef<GameMode | null>(null);
  
  // 백그라운드 소리 정지를 위한 Visibility Ref
  const isVisibleRef = useRef<boolean>(true);

  // 배너 광고 닫기/정리를 위한 Ref
  const bannerResultRef = useRef<any>(null);

  useEffect(() => {
    scoreRef.current = score;
  }, [score]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // 1) 세로 모드 고정 및 Safe Area 초기 바인딩
  useEffect(() => {
    try {
      Screen.setOrientation({ type: 'portrait' });
    } catch (err) {
      console.warn('Failed to set screen orientation to portrait:', err);
    }

    try {
      const initialInsets = SafeArea.get();
      setSafeArea(initialInsets);
    } catch (err) {
      console.warn('Failed to get initial safe area insets:', err);
    }

    try {
      const unsubscribe = SafeArea.subscribe({
        onEvent: (insets) => {
          setSafeArea(insets);
        },
      });
      return () => {
        unsubscribe();
      };
    } catch (err) {
      console.warn('Failed to subscribe to safe area insets:', err);
    }
  }, []);

  // 3) 브라우저 뒤로가기 동작 대응 (뒤로가기 시도 시 닫기 확인 모달 노출)
  useEffect(() => {
    window.history.pushState({ prevScreen: 'init' }, '');

    const handlePopState = () => {
      setShowCloseModal(true);
      window.history.pushState({ prevScreen: 'init' }, '');
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  // 5) 사운드 설정값 로드
  const loadSoundSetting = useCallback(async () => {
    try {
      const saved = await safeGetItem('sound_enabled');
      if (saved !== null) {
        setSoundEnabled(saved === 'true');
      } else {
        setSoundEnabled(true);
      }
    } catch (err) {
      console.error('Failed to load sound setting:', err);
      setSoundEnabled(true);
    }
  }, []);

  // 6) 백그라운드 전환 상태 모니터링
  useEffect(() => {
    const handleVisibilityChange = () => {
      isVisibleRef.current = document.visibilityState === 'visible';
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // 6단계: 배너 광고 동적 Attach 및 Destroy 처리
  useEffect(() => {
    if (screen === 'select' || screen === 'result') {
      const timer = setTimeout(() => {
        try {
          const container = document.getElementById('banner-ad-container');
          if (container) {
            bannerResultRef.current = TossAds.attachBanner(AD_ID_BANNER, container);
          }
        } catch (err) {
          console.warn('Failed to attach banner ad:', err);
        }
      }, 50);

      return () => {
        clearTimeout(timer);
        if (bannerResultRef.current) {
          try {
            bannerResultRef.current.destroy();
          } catch (err) {
            console.warn('Failed to destroy banner ad:', err);
          }
          bannerResultRef.current = null;
        }
      };
    }
  }, [screen]);

  // AIT Storage API로부터 최고 점수 로드
  const loadHighScores = useCallback(async () => {
    try {
      const qScore = await safeGetItem('highscore_quiz');
      const mScore = await safeGetItem('highscore_math');
      const gScore = await safeGetItem('highscore_geo');
      setHighScoreQuiz(qScore !== null ? Number(qScore) : 0);
      setHighScoreMath(mScore !== null ? Number(mScore) : 0);
      setHighScoreGeo(gScore !== null ? Number(gScore) : 0);
    } catch (err) {
      console.error('Failed to load high scores:', err);
      setHighScoreQuiz(0);
      setHighScoreMath(0);
      setHighScoreGeo(0);
    }
  }, []);

  // 앱 시작 또는 메인 화면 복귀 시 최고 점수 및 사운드 설정 로드
  useEffect(() => {
    if (screen === 'select') {
      loadHighScores();
      loadSoundSetting();
    }
  }, [screen, loadHighScores, loadSoundSetting]);

  // CSV 로드 및 파싱 (상식 퀴즈 및 지리 추론용)
  useEffect(() => {
    let quizLoaded = false;
    let geoLoaded = false;

    // 상식 퀴즈 로드
    fetch('./quiz.csv')
      .then((res) => {
        if (!res.ok) throw new Error('Network response was not ok');
        return res.text();
      })
      .then((csvText) => {
        Papa.parse<QuizItem>(csvText, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => {
            setQuizzes(results.data);
            quizLoaded = true;
            if (geoLoaded) setIsLoading(false);
          },
        });
      })
      .catch((err) => {
        console.error('Fetch quiz CSV Error:', err);
        quizLoaded = true;
        if (geoLoaded) setIsLoading(false);
      });

    // 지리 추론 로드
    fetch('./geo_quiz.csv')
      .then((res) => {
        if (!res.ok) throw new Error('Network response was not ok');
        return res.text();
      })
      .then((csvText) => {
        Papa.parse<GeoQuestion>(csvText, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => {
            setGeoQuestions(results.data);
            geoLoaded = true;
            if (quizLoaded) setIsLoading(false);
          },
        });
      })
      .catch((err) => {
        console.error('Fetch geo_quiz CSV Error:', err);
        geoLoaded = true;
        if (quizLoaded) setIsLoading(false);
      });
  }, []);

  // Web Audio API를 활용한 온더플라이 효과음 합성 재생
  const playBeepSound = (isCorrect: boolean) => {
    // 광고가 송출 중일 때는 효과음 재생 금지
    if (!soundEnabled || !isVisibleRef.current || isAdPlaying) return;
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;
      const ctx = new AudioContextClass();

      if (isCorrect) {
        const now = ctx.currentTime;
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(523.25, now); // C5
        gain1.gain.setValueAtTime(0.08, now);
        gain1.gain.exponentialRampToValueAtTime(0.005, now + 0.12);
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.start(now);
        osc1.stop(now + 0.12);

        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(659.25, now + 0.08); // E5
        gain2.gain.setValueAtTime(0.08, now + 0.08);
        gain2.gain.exponentialRampToValueAtTime(0.005, now + 0.22);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(now + 0.08);
        osc2.stop(now + 0.22);
      } else {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(220, now); // A3
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.005, now + 0.25);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.25);
      }
    } catch (err) {
      console.error('Failed to play beep sound:', err);
    }
  };

  // 햅틱 진동 피드백
  const triggerHaptic = async (isCorrect: boolean) => {
    try {
      await Device.triggerHaptic({ type: isCorrect ? 'success' : 'error' });
    } catch (err) {
      console.warn('Haptic feedback not supported or failed:', err);
    }
  };

  // 사운드 토글 처리
  const toggleSound = async () => {
    const nextVal = !soundEnabled;
    setSoundEnabled(nextVal);
    try {
      await safeSetItem('sound_enabled', String(nextVal));
    } catch (err) {
      console.error('Failed to save sound setting:', err);
    }
  };

  // 게임 종료 시 저장소에 점수 보관 및 신기록 판정
  const handleGameEnd = useCallback(async () => {
    const finalScore = scoreRef.current;
    const activeMode = modeRef.current;
    if (!activeMode) return;

    let isNew = false;
    try {
      if (activeMode === 'quiz') {
        if (finalScore > highScoreQuiz) {
          isNew = true;
          await safeSetItem('highscore_quiz', String(finalScore));
          setHighScoreQuiz(finalScore);
        }
      } else if (activeMode === 'math') {
        if (finalScore > highScoreMath) {
          isNew = true;
          await safeSetItem('highscore_math', String(finalScore));
          setHighScoreMath(finalScore);
        }
      } else if (activeMode === 'geo') {
        if (finalScore > highScoreGeo) {
          isNew = true;
          await safeSetItem('highscore_geo', String(finalScore));
          setHighScoreGeo(finalScore);
        }
      }
    } catch (err) {
      console.error('Failed to save high score to Storage:', err);
    }

    setIsNewRecord(isNew);
    setScreen('result');
  }, [highScoreQuiz, highScoreMath, highScoreGeo]);

  // 카운트다운 타이머 설정 및 정리 (시작 시 timeLeft에 비례해 작동)
  useEffect(() => {
    if (screen !== 'playing') return;
    if (mode === 'geo') return; // 지리 추론 모드는 타이머가 없음

    const interval = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          handleGameEnd();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      clearInterval(interval);
    };
  }, [screen, mode, handleGameEnd]);

  // 리워드 광고 "광고 보고 이어하기" 처리
  const handleContinueWithAd = () => {
    if (hasContinued || isAdLoading) return;

    setIsAdLoading(true);
    setIsAdPlaying(true); // 광고 재생 시 오디오 정지 연동

    let earnedReward = false;

    try {
      loadFullScreenAd({
        options: { adGroupId: AD_ID_REWARDED },
        onEvent: (event) => {
          if (event.type === 'loaded') {
            setIsAdLoading(false);

            showFullScreenAd({
              options: { adGroupId: AD_ID_REWARDED },
              onEvent: (showEvent) => {
                if (showEvent.type === 'userEarnedReward') {
                  earnedReward = true;
                } else if (showEvent.type === 'dismissed') {
                  setIsAdPlaying(false);
                  if (earnedReward) {
                    setHasContinued(true);
                    setTimeLeft(30); // 30초 이어하기 보상 설정
                    setScreen('playing');
                  } else {
                    alert('광고를 끝까지 시청하지 않아 이어하기가 제공되지 않습니다.');
                  }
                } else if (showEvent.type === 'failedToShow') {
                  setIsAdPlaying(false);
                  setIsAdLoading(false);
                  alert('광고 화면을 표시할 수 없습니다.');
                }
              },
              onError: (err) => {
                console.error('showFullScreenAd Error:', err);
                setIsAdPlaying(false);
                setIsAdLoading(false);
                alert('광고 송출 중 에러가 발생했습니다.');
              },
            });
          }
        },
        onError: (err) => {
          console.error('loadFullScreenAd Error:', err);
          setIsAdPlaying(false);
          setIsAdLoading(false);
          alert('광고를 불러올 수 없습니다. 브라우저/로컬 환경에서는 광고 호출이 생략되거나 오류가 발생할 수 있습니다.');
        },
      });
    } catch (err) {
      console.error('TossAds System Error:', err);
      setIsAdPlaying(false);
      setIsAdLoading(false);
      alert('광고 시스템 연결 중 에러가 발생했습니다.');
    }
  };

  // 2) 네이티브 앱 닫기 기능 호출 및 모달 제어
  const handleCloseConfirm = async () => {
    try {
      await Screen.close();
    } catch (err) {
      console.error('Failed to close app via SDK:', err);
      setShowCloseModal(false);
    }
  };

  // 퀴즈 문제의 정답 텍스트 파싱
  const getCorrectQuizAnswerText = (quiz: QuizItem): string => {
    const answerIndex = parseInt(quiz.answer, 10);
    if (answerIndex === 1) return quiz.choice1;
    if (answerIndex === 2) return quiz.choice2;
    if (answerIndex === 3) return quiz.choice3;
    if (answerIndex === 4) return quiz.choice4;
    return '';
  };

  // 모드별 정답 텍스트 가져오기
  const getCorrectAnswerText = (): string => {
    if (mode === 'quiz') {
      return currentQuiz ? getCorrectQuizAnswerText(currentQuiz) : '';
    } else if (mode === 'math') {
      return currentMathProblem ? currentMathProblem.answer.toString() : '';
    }
    return '';
  };

  // 상식 퀴즈 다음 문제 출제
  const loadNextQuizQuestion = (queue: QuizItem[], allQuizzes: QuizItem[]) => {
    let activeQueue = [...queue];
    if (activeQueue.length === 0) {
      activeQueue = shuffleArray(allQuizzes);
    }
    const nextQuiz = activeQueue.pop() || null;
    setQuizQueue(activeQueue);
    setCurrentQuiz(nextQuiz);

    if (nextQuiz) {
      const choices = [nextQuiz.choice1, nextQuiz.choice2, nextQuiz.choice3, nextQuiz.choice4];
      setShuffledChoices(shuffleArray(choices));
    } else {
      setShuffledChoices([]);
    }
    setSelectedChoice(null);
    setIsAnswered(false);
  };

  // 빠른 계산 다음 문제 출제
  const loadNextMathQuestion = () => {
    const problem = generateMathProblem();
    setCurrentMathProblem(problem);
    const choices = generateMathChoices(problem.answer);
    setShuffledChoices(choices);
    setSelectedChoice(null);
    setIsAnswered(false);
  };

  // 상식 퀴즈 시작
  const startQuizGame = () => {
    if (quizzes.length === 0) return;
    setScore(0);
    setTimeLeft(60);
    setIsNewRecord(false);
    setHasContinued(false); // 이어하기 초기화

    const initialQueue = shuffleArray(quizzes);
    const firstQuiz = initialQueue.pop() || null;
    setQuizQueue(initialQueue);
    setCurrentQuiz(firstQuiz);

    if (firstQuiz) {
      const choices = [firstQuiz.choice1, firstQuiz.choice2, firstQuiz.choice3, firstQuiz.choice4];
      setShuffledChoices(shuffleArray(choices));
    } else {
      setShuffledChoices([]);
    }
    setSelectedChoice(null);
    setIsAnswered(false);
    setMode('quiz');
    setScreen('playing');
  };

  // 빠른 계산 시작
  const startMathGame = () => {
    setScore(0);
    setTimeLeft(60);
    setIsNewRecord(false);
    setHasContinued(false); // 이어하기 초기화

    const problem = generateMathProblem();
    setCurrentMathProblem(problem);
    const choices = generateMathChoices(problem.answer);
    setShuffledChoices(choices);
    setSelectedChoice(null);
    setIsAnswered(false);
    setMode('math');
    setScreen('playing');
  };

  // 지리 추론 시작
  const startGeoGame = () => {
    if (geoQuestions.length === 0) return;
    setScore(0);
    setIsNewRecord(false);
    setHasContinued(false);

    // 300문제 중 무작위 10문제 추출
    const shuffled = shuffleArray(geoQuestions);
    const session = shuffled.slice(0, 10);

    setGeoSessionQuestions(session);
    setGeoCurrentIndex(0);
    setOpenedHintsCount(1); // 첫 번째 힌트는 처음부터 제시
    setGeoInput('');
    setIsCorrectGeo(false);
    setIsAnswered(false);
    setShowExplanation(false);
    setImgError(false);
    setMode('geo');
    setScreen('playing');
  };

  // 모드 선택 처리
  const startNewGame = (selectedMode: GameMode) => {
    if (selectedMode === 'quiz') {
      startQuizGame();
    } else if (selectedMode === 'math') {
      startMathGame();
    } else if (selectedMode === 'geo') {
      startGeoGame();
    }
  };

  // 주관식 텍스트 가공 함수
  const cleanString = (str: string) => {
    return str.replace(/\s+/g, '').toLowerCase().trim();
  };

  // 주관식 정답 판정 함수
  const checkGeoAnswer = (input: string, question: GeoQuestion) => {
    const cleanedInput = cleanString(input);
    if (!cleanedInput) return false;

    const answers = [
      question.answer_ko,
      question.answer_en,
      ...question.acceptable_answers.split(',')
    ];

    return answers.some((ans) => cleanString(ans) === cleanedInput);
  };

  // 힌트 순차 개방 핸들러
  const handleOpenHint = () => {
    if (openedHintsCount < 3) {
      setOpenedHintsCount((prev) => prev + 1);
    }
  };

  // 지리 추론 정답 제출 핸들러
  const handleGeoSubmit = () => {
    if (isAnswered) return;
    const currentQuestion = geoSessionQuestions[geoCurrentIndex];
    if (!currentQuestion) return;

    const isCorrect = checkGeoAnswer(geoInput, currentQuestion);
    if (isCorrect) {
      setIsCorrectGeo(true);
      setIsAnswered(true);

      // 힌트 개수에 따른 점수 반영 (첫 힌트는 기본제공으로 1인 상태가 추가 힌트 미사용(0개 추가)을 의미)
      let points = GEO_SCORE_WRONG;
      if (openedHintsCount === 1) points = GEO_SCORE_HINT_0;      // 100점
      else if (openedHintsCount === 2) points = GEO_SCORE_HINT_1; // 70점
      else if (openedHintsCount === 3) points = GEO_SCORE_HINT_2; // 40점

      setScore((prev) => prev + points);
      playBeepSound(true);
      triggerHaptic(true);
      setShowExplanation(true);
    } else {
      playBeepSound(false);
      triggerHaptic(false);
      alert('오답입니다! 다시 한 번 생각해보세요.');
    }
  };

  // 지리 추론 포기/정답 보기 핸들러
  const handleGeoGiveUp = () => {
    if (isAnswered) return;
    setIsCorrectGeo(false);
    setIsAnswered(true);
    playBeepSound(false);
    triggerHaptic(false);
    setShowExplanation(true);
  };

  // 다음 지리 문제 전환 핸들러
  const handleGeoNext = () => {
    if (geoCurrentIndex < 9) {
      setGeoCurrentIndex((prev) => prev + 1);
      setOpenedHintsCount(1); // 첫 번째 힌트는 항상 시작부터 노출
      setGeoInput('');
      setIsCorrectGeo(false);
      setIsAnswered(false);
      setShowExplanation(false);
      setImgError(false);
    } else {
      handleGameEnd();
    }
  };

  // 선택지 클릭 핸들러
  const handleChoiceClick = (choiceText: string) => {
    if (isAnswered) return;
    setIsAnswered(true);
    setSelectedChoice(choiceText);

    // 정답 판정 및 채점
    const correctText = getCorrectAnswerText();
    const isCorrect = choiceText === correctText;
    if (isCorrect) {
      setScore((prev) => prev + 1);
    }

    // 효과음 및 햅틱 진동 피드백 유발
    playBeepSound(isCorrect);
    triggerHaptic(isCorrect);

    // 0.7초 지연 후 다음 문제 출제
    setTimeout(() => {
      if (mode === 'quiz') {
        loadNextQuizQuestion(quizQueue, quizzes);
      } else if (mode === 'math') {
        loadNextMathQuestion();
      }
    }, 700);
  };

  const endGame = () => {
    handleGameEnd();
  };

  const handleRetry = () => {
    if (mode === 'quiz') {
      startQuizGame();
    } else if (mode === 'math') {
      startMathGame();
    } else if (mode === 'geo') {
      startGeoGame();
    }
  };

  const handleGoToSelect = () => {
    setMode(null);
    setScreen('select');
  };

  // 화면에 표시될 문제 텍스트
  const questionText = mode === 'quiz'
    ? (currentQuiz ? currentQuiz.question : '문제를 불러오는 중...')
    : (currentMathProblem ? currentMathProblem.question : '');

  return (
    <div
      className={`app-container theme-${mode || 'default'}`}
      style={{
        paddingTop: `${Math.max(safeArea.top, 24)}px`,
        paddingBottom: `${Math.max(safeArea.bottom, 24)}px`,
        paddingLeft: `${Math.max(safeArea.left, 20)}px`,
        paddingRight: `${Math.max(safeArea.right, 20)}px`,
      }}
    >
      {/* 1. 모드 선택 화면 */}
      {screen === 'select' && (
        <div className="screen-wrapper">
          <div className="header-bar" style={{ justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="sound-toggle-btn" onClick={toggleSound}>
                {soundEnabled ? '🔊 소리' : '🔇 소리'}
              </button>
              <button className="info-button" onClick={() => setShowInfoModal(true)}>
                ℹ️ 정보
              </button>
            </div>
            <button
              className="close-button"
              aria-label="Close"
              onClick={() => setShowCloseModal(true)}
            >
              ✕
            </button>
          </div>

          <h1 className="main-title">
            두뇌 스피드
            <br />
            테스트
          </h1>

          {/* 법적 고지 등급 표시 마크 (시작 화면 타이틀 아래 노출) */}
          <div className="grac-start-badge-wrapper">
            <GameRatingInfo onlyBadge={true} />
          </div>

          {/* 오락실 타이틀 데코레이션 */}
          <div className="arcade-deco-container">
            <div className="insert-coin-text">INSERT COIN (1 CREDIT)</div>
            <div className="arcade-joystick-deco">🕹️ 🔴 🟡</div>
          </div>

          <div className="mode-list">
            <button
              className="mode-card card-quiz"
              onClick={() => startNewGame('quiz')}
              disabled={isLoading}
              style={{ opacity: isLoading ? 0.6 : 1 }}
            >
              <span className="mode-card-title">📚 상식 퀴즈</span>
              <span className="mode-card-score">
                {isLoading ? '문제 불러오는 중...' : `최고 점수: ${highScoreQuiz}`}
              </span>
            </button>

            <button
              className="mode-card card-math"
              onClick={() => startNewGame('math')}
              disabled={isLoading}
              style={{ opacity: isLoading ? 0.6 : 1 }}
            >
              <span className="mode-card-title">⚡ 빠른 계산</span>
              <span className="mode-card-score">
                {isLoading ? '문제 불러오는 중...' : `최고 점수: ${highScoreMath}`}
              </span>
            </button>

            <button
              className="mode-card card-geo"
              onClick={() => startNewGame('geo')}
              disabled={isLoading}
              style={{ opacity: isLoading ? 0.6 : 1 }}
            >
              <span className="mode-card-title">🗺️ 지리 추론</span>
              <span className="mode-card-score">
                {isLoading ? '문제 불러오는 중...' : `최고 점수: ${highScoreGeo}`}
              </span>
            </button>
          </div>

          {/* 배너 광고 영역 */}
          <div id="banner-ad-container" className="banner-ad-container">
            광고 영역
          </div>
        </div>
      )}

      {/* 2. 게임 화면 */}
      {screen === 'playing' && (
        <div className="screen-wrapper">
          <div className="game-header">
            <div className="game-header-info">
              <span className="game-header-label">
                {mode === 'geo' ? '진행도' : '남은 시간'}
              </span>
              <span className="game-header-value">
                {mode === 'geo' ? `${geoCurrentIndex + 1} / 10` : timeLeft}
              </span>
            </div>

            <span className="game-mode-tag">
              {mode === 'quiz' ? '상식 퀴즈' : mode === 'math' ? '빠른 계산' : '지리 추론'}
            </span>

            <div className="game-header-info" style={{ alignItems: 'flex-end' }}>
              <span className="game-header-label">현재 점수</span>
              <span className="game-header-value">{score}</span>
            </div>
          </div>

          {/* 타이머 바 시각 구현 (지리 모드 아닐때만 노출) */}
          {mode !== 'geo' && (
            <div className="timer-bar-container">
              <div className="timer-bar" style={{ width: `${(timeLeft / 60) * 100}%` }} />
            </div>
          )}

          <div className="problem-container">
            {mode === 'geo' ? (
              imgError || !geoSessionQuestions[geoCurrentIndex] ? (
                <div className="geo-img-fallback-box" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                  <span className="geo-img-fallback-cat" style={{ fontFamily: 'DungGeunMo', color: 'var(--theme-main)', fontSize: '14px' }}>
                    [{geoSessionQuestions[geoCurrentIndex]?.category}]
                  </span>
                  <span className="geo-img-fallback-text" style={{ fontSize: '13px', color: 'var(--retro-text-muted)' }}>
                    사진을 표시할 수 없습니다
                  </span>
                </div>
              ) : (
                <img
                  src={`./images/${geoSessionQuestions[geoCurrentIndex].id}.webp`}
                  alt="지리 추론 퀴즈"
                  className="geo-quiz-image"
                  onError={() => setImgError(true)}
                />
              )
            ) : (
              <span className="problem-text">{questionText}</span>
            )}
          </div>

          {mode === 'geo' ? (
            <>
              {/* 지리 추론 힌트 슬롯 */}
              {geoSessionQuestions[geoCurrentIndex] && (
                <div className="geo-hints-container">
                  <div className="geo-hint-row">
                    <span className="geo-hint-label">힌트 1 (구분: {geoSessionQuestions[geoCurrentIndex].category} / 난이도: {geoSessionQuestions[geoCurrentIndex].difficulty}):</span>
                    <span className="geo-hint-text">
                      {openedHintsCount >= 1 ? geoSessionQuestions[geoCurrentIndex].hint_1 : '🔒 첫 번째 힌트 (잠김)'}
                    </span>
                  </div>
                  <div className="geo-hint-row">
                    <span className="geo-hint-label">힌트 2:</span>
                    <span className="geo-hint-text">
                      {openedHintsCount >= 2 ? geoSessionQuestions[geoCurrentIndex].hint_2 : '🔒 두 번째 힌트 (잠김)'}
                    </span>
                  </div>
                  <div className="geo-hint-row">
                    <span className="geo-hint-label">힌트 3:</span>
                    <span className="geo-hint-text">
                      {openedHintsCount >= 3 ? geoSessionQuestions[geoCurrentIndex].hint_3 : '🔒 세 번째 힌트 (잠김)'}
                    </span>
                  </div>

                  {!isAnswered && openedHintsCount < 3 && (
                    <button className="btn-open-hint" onClick={handleOpenHint}>
                      💡 힌트 {openedHintsCount + 1} 열기 (획득 점수: {openedHintsCount === 1 ? '100 ➡️ 70점' : '70 ➡️ 40점'})
                    </button>
                  )}
                </div>
              )}

              {/* 정답 입력 영역 */}
              {!showExplanation ? (
                <div className="geo-input-section">
                  <input
                    type="text"
                    className="geo-text-input"
                    placeholder="도시명 또는 랜드마크 입력"
                    value={geoInput}
                    onChange={(e) => setGeoInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleGeoSubmit();
                    }}
                  />
                  <div className="geo-submit-row">
                    <button className="btn-geo-submit" onClick={handleGeoSubmit}>
                      정답 제출
                    </button>
                    <button className="btn-geo-giveup" onClick={handleGeoGiveUp}>
                      포기 / 정답 보기
                    </button>
                  </div>
                </div>
              ) : (
                geoSessionQuestions[geoCurrentIndex] && (
                  <div className="geo-explanation-section">
                    <div className="geo-answer-result">
                      {isCorrectGeo ? (
                        <span className="result-correct-label">🎉 정답입니다! (+{openedHintsCount === 1 ? 100 : openedHintsCount === 2 ? 70 : 40}점)</span>
                      ) : (
                        <span className="result-incorrect-label">😢 오답 처리되었습니다. (정답: {geoSessionQuestions[geoCurrentIndex].answer_ko})</span>
                      )}
                    </div>
                    <div className="geo-explanation-box">
                      <strong>정답 해설:</strong> {geoSessionQuestions[geoCurrentIndex].explanation}
                    </div>
                    <button className="btn-geo-next" onClick={handleGeoNext}>
                      {geoCurrentIndex < 9 ? '다음 문제로 ➡️' : '결과 보기 🏆'}
                    </button>
                  </div>
                )
              )}
            </>
          ) : (
            /* 기존 사지선다 선택지 리스트 */
            <div className="choice-list">
              {shuffledChoices.map((choice, idx) => {
                const isSelected = selectedChoice === choice;
                const correctText = getCorrectAnswerText();
                const isCorrect = choice === correctText;

                let btnClass = 'choice-button';
                if (isAnswered) {
                  if (isCorrect) {
                    btnClass += ' correct';
                  } else if (isSelected) {
                    btnClass += ' incorrect';
                  }
                }

                return (
                  <button
                    key={idx}
                    className={btnClass}
                    disabled={isAnswered}
                    onClick={() => handleChoiceClick(choice)}
                  >
                    {choice}
                  </button>
                );
              })}
            </div>
          )}

          <div className="dev-action-bar">
            <button className="end-game-btn" onClick={endGame}>
              게임 종료
            </button>
          </div>
        </div>
      )}

      {/* 3. 결과 화면 */}
      {screen === 'result' && (
        <div className="screen-wrapper">
          <div className="result-container">
            <div className="result-icon">🏆</div>
            <h2 className="result-title">게임 종료!</h2>

            <div className="result-score-box">
              <div className="result-score-label">이번 점수</div>
              <div className="result-score-value">{score}점</div>
              {isNewRecord && (
                <div className="new-record-badge">🎉 최고 기록 갱신!</div>
              )}
            </div>

            <div className="action-buttons">
              {/* 리워드 광고 이어하기 버튼 */}
              {mode !== 'geo' && (
                <button
                  className="btn-rewarded"
                  onClick={handleContinueWithAd}
                  disabled={hasContinued || isAdLoading}
                  style={{ marginBottom: '8px' }}
                >
                  {isAdLoading ? '광고 불러오는 중...' : hasContinued ? '이어하기 완료' : '📺 광고 보고 30초 이어하기'}
                </button>
              )}

              <button className="btn-primary" onClick={handleRetry}>
                다시 하기
              </button>
              <button className="btn-secondary" onClick={handleGoToSelect}>
                모드 선택으로
              </button>
            </div>
          </div>

          {/* 배너 광고 영역 */}
          <div id="banner-ad-container" className="banner-ad-container">
            광고 영역
          </div>
        </div>
      )}

      {/* 4) 종료 확인 모달 */}
      {showCloseModal && (
        <div className="modal-overlay">
          <div className="modal-container">
            <h3 className="modal-title">게임을 종료하시겠어요?</h3>
            <div className="modal-buttons">
              <button className="btn-modal-cancel" onClick={() => setShowCloseModal(false)}>
                취소
              </button>
              <button className="btn-modal-confirm" onClick={handleCloseConfirm}>
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5) 게임 정보 및 등급분류 고지 모달 */}
      {showInfoModal && (
        <div className="modal-overlay">
          <div className="modal-container" style={{ maxWidth: '340px', width: '90%' }}>
            <h3 className="modal-title" style={{ marginBottom: '16px' }}>게임 정보</h3>
            <div style={{ marginBottom: '24px' }}>
              <GameRatingInfo onlyBadge={false} />
            </div>
            <div className="modal-buttons">
              <button className="btn-modal-confirm" onClick={() => setShowInfoModal(false)}>
                닫기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
