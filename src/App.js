import { useState, useRef, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine, ResponsiveContainer } from 'recharts';
import proData from './data/pickle_backhand_baseline_drive_pro.json';
import './App.css';

const PickleballBackhandAnalysisV8 = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [traineeFileName, setTraineeFileName] = useState('');
  const [comparisonData, setComparisonData] = useState({
    wristHip: [],
    shoulderRotation: [],
    weightTransfer: [],
    armExtension: []
  });
  const [phaseMarkers, setPhaseMarkers] = useState([]);
  const [statsComparison, setStatsComparison] = useState(null);
  const [dynamicRecommendations, setDynamicRecommendations] = useState(null);
  const fileInputRef = useRef(null);

  // Move all helper functions BEFORE they are used

  const getEmbeddedProData = () => {
    return proData;
  };

  const extractMetrics = (frames, playerType) => {
    const metrics = {
      wristHip: [],
      shoulderRotation: [],
      weightTransfer: [],
      armExtension: [],
      frameIds: []
    };

    frames.forEach((frame) => {
      const person = frame.primitives?.people?.[0];
      if (!person || !person.pose) return;

      const pose = person.pose;
      const frameId = frame.frameId;
      const timestamp = frame.timestamp || 0;

      // Extract wrist-hip vertical differential
      if (pose.rightWrist && pose.rightWrist.y > 0 && pose.rightHip && pose.rightHip.y > 0) {
        const wristHipDiff = pose.rightWrist.y - pose.rightHip.y;
        metrics.wristHip.push({
          frameId,
          timestamp,
          value: wristHipDiff,
          playerType
        });
      }

      // Extract shoulder rotation (using shoulder width as proxy)
      if (pose.leftShoulder && pose.rightShoulder &&
          pose.leftShoulder.x > 0 && pose.rightShoulder.x > 0) {
        const shoulderWidth = Math.abs(pose.leftShoulder.x - pose.rightShoulder.x);
        const rotation = (shoulderWidth / 50) * 45;
        metrics.shoulderRotation.push({
          frameId,
          timestamp,
          value: rotation,
          playerType
        });
      }

      // Extract weight transfer
      if (pose.leftAnkle && pose.rightAnkle &&
          pose.leftAnkle.x > 0 && pose.rightAnkle.x > 0) {
        const totalX = pose.leftAnkle.x + pose.rightAnkle.x;
        const rightFootPercentage = (pose.rightAnkle.x / totalX) * 100;
        metrics.weightTransfer.push({
          frameId,
          timestamp,
          value: rightFootPercentage,
          playerType
        });
      }

      // Extract arm extension
      if (pose.rightShoulder && pose.rightWrist &&
          pose.rightShoulder.x > 0 && pose.rightWrist.x > 0 &&
          pose.rightShoulder.y > 0 && pose.rightWrist.y > 0) {
        const distance = Math.sqrt(
          Math.pow(pose.rightWrist.x - pose.rightShoulder.x, 2) +
          Math.pow(pose.rightWrist.y - pose.rightShoulder.y, 2)
        );
        metrics.armExtension.push({
          frameId,
          timestamp,
          value: distance,
          playerType
        });
      }

      metrics.frameIds.push(frameId);
    });

    return metrics;
  };

  const findAnchorPoints = (wristHipData) => {
    if (!wristHipData || wristHipData.length === 0) return null;

    // Find the minimum point (maximum wrist drop)
    let minValue = Infinity;
    let minIndex = -1;

    wristHipData.forEach((point, index) => {
      if (point.value < minValue) {
        minValue = point.value;
        minIndex = index;
      }
    });

    // Find approximate phase boundaries
    let backswingStart = 0;
    for (let i = 1; i < minIndex; i++) {
      const rate = wristHipData[i].value - wristHipData[i-1].value;
      if (rate < -2) {
        backswingStart = Math.max(0, i - 5);
        break;
      }
    }

    let forwardSwingStart = minIndex;
    for (let i = minIndex + 1; i < wristHipData.length - 1; i++) {
      const rate = wristHipData[i+1].value - wristHipData[i].value;
      if (rate > 2) {
        forwardSwingStart = i;
        break;
      }
    }

    let followThroughEnd = wristHipData.length - 1;
    for (let i = forwardSwingStart + 10; i < wristHipData.length - 5; i++) {
      const variance = Math.abs(wristHipData[i+1].value - wristHipData[i].value);
      if (variance < 1) {
        followThroughEnd = i + 5;
        break;
      }
    }

    return {
      backswingStart,
      backswingPeak: minIndex,
      forwardSwingStart,
      followThroughEnd,
      minValue
    };
  };

  const mapPercentToIndex = (percent, anchors, dataLength) => {
    const strokeStart = anchors.backswingStart;
    const strokeEnd = anchors.followThroughEnd;
    const strokeLength = strokeEnd - strokeStart;

    return strokeStart + (strokeLength * percent / 100);
  };

  const interpolateValue = (data, index) => {
    if (!data || data.length === 0) return 0;

    const floorIndex = Math.floor(index);
    const ceilIndex = Math.ceil(index);

    if (floorIndex >= data.length - 1) return data[data.length - 1].value;
    if (floorIndex === ceilIndex) return data[floorIndex].value;

    const fraction = index - floorIndex;
    const floorValue = data[floorIndex].value;
    const ceilValue = data[ceilIndex].value;

    return floorValue + (ceilValue - floorValue) * fraction;
  };

  const calculateComparisonStats = (proMetrics, traineeMetrics, proAnchors, traineeAnchors) => {
    const proStrokeDuration = (proAnchors.followThroughEnd - proAnchors.backswingStart) / 30;
    const traineeStrokeDuration = (traineeAnchors.followThroughEnd - traineeAnchors.backswingStart) / 30;

    const proMaxRotation = Math.max(...proMetrics.shoulderRotation.map(d => d.value));
    const traineeMaxRotation = Math.max(...traineeMetrics.shoulderRotation.map(d => d.value));

    const proMaxExtension = Math.max(...proMetrics.armExtension.map(d => d.value));
    const traineeMaxExtension = Math.max(...traineeMetrics.armExtension.map(d => d.value));

    return {
      strokeDuration: {
        pro: proStrokeDuration.toFixed(2),
        trainee: traineeStrokeDuration.toFixed(2),
        difference: ((traineeStrokeDuration - proStrokeDuration) * 1000).toFixed(0)
      },
      peakRotation: {
        pro: proMaxRotation.toFixed(1),
        trainee: traineeMaxRotation.toFixed(1),
        difference: (traineeMaxRotation - proMaxRotation).toFixed(1)
      },
      peakExtension: {
        pro: proMaxExtension.toFixed(1),
        trainee: traineeMaxExtension.toFixed(1),
        difference: (traineeMaxExtension - proMaxExtension).toFixed(1)
      },
      wristDrop: {
        pro: proAnchors.minValue.toFixed(1),
        trainee: traineeAnchors.minValue.toFixed(1),
        difference: (traineeAnchors.minValue - proAnchors.minValue).toFixed(1)
      }
    };
  };

  const generateDemoNormalizedData = () => {
    // Your existing generateDemoNormalizedData function
    const comparison = {
      wristHip: [],
      shoulderRotation: [],
      weightTransfer: [],
      armExtension: []
    };

    for (let percent = 0; percent <= 100; percent += 2) {
      let proWristHip, traineeWristHip;
      if (percent < 30) {
        proWristHip = -30 - (percent * 1);
        traineeWristHip = -25 - (percent * 0.8);
      } else if (percent < 60) {
        const progress = (percent - 30) / 30;
        proWristHip = -60 + (progress * 40);
        traineeWristHip = -45 + (progress * 35);
      } else if (percent < 70) {
        proWristHip = -20;
        traineeWristHip = -10;
      } else {
        const progress = (percent - 70) / 30;
        proWristHip = -20 + (progress * 5);
        traineeWristHip = -10 + (progress * 2);
      }

      let proRotation, traineeRotation;
      if (percent < 30) {
        proRotation = 10 + (percent * 1.17);
        traineeRotation = 10 + (percent * 0.83);
      } else if (percent < 60) {
        const progress = (percent - 30) / 30;
        proRotation = 45 - (progress * 15);
        traineeRotation = 35 - (progress * 10);
      } else {
        proRotation = 30 - ((percent - 60) * 0.5);
        traineeRotation = 25 - ((percent - 60) * 0.3);
      }

      let proWeight, traineeWeight;
      if (percent < 30) {
        proWeight = 50 - (percent * 0.83);
        traineeWeight = 50 - (percent * 0.5);
      } else if (percent < 70) {
        const progress = (percent - 30) / 40;
        proWeight = 25 + (progress * 50);
        traineeWeight = 35 + (progress * 30);
      } else {
        proWeight = 75 + ((percent - 70) * 0.17);
        traineeWeight = 65 + ((percent - 70) * 0.1);
      }

      let proExtension, traineeExtension;
      if (percent < 30) {
        proExtension = 50 - (percent * 0.33);
        traineeExtension = 50 - (percent * 0.2);
      } else if (percent < 70) {
        const progress = (percent - 30) / 40;
        proExtension = 40 + (progress * 40);
        traineeExtension = 45 + (progress * 25);
      } else {
        const progress = (percent - 70) / 30;
        proExtension = 80 + (progress * 20);
        traineeExtension = 70 + (progress * 10);
      }

      comparison.wristHip.push({
        strokePercent: percent,
        proValue: proWristHip,
        traineeValue: traineeWristHip
      });

      comparison.shoulderRotation.push({
        strokePercent: percent,
        proValue: proRotation,
        traineeValue: traineeRotation
      });

      comparison.weightTransfer.push({
        strokePercent: percent,
        proValue: proWeight,
        traineeValue: traineeWeight
      });

      comparison.armExtension.push({
        strokePercent: percent,
        proValue: proExtension,
        traineeValue: traineeExtension
      });
    }

    const phases = [
      { phase: 'Backswing', start: 0, end: 30, color: '#82ca9d' },
      { phase: 'Forward Swing', start: 30, end: 60, color: '#ff7300' },
      { phase: 'Contact', start: 60, end: 70, color: '#ff0000' },
      { phase: 'Follow-through', start: 70, end: 100, color: '#0088fe' }
    ];

    const stats = {
      strokeDuration: {
        pro: "1.50",
        trainee: "1.75",
        difference: "250"
      },
      peakRotation: {
        pro: "45.0",
        trainee: "35.0",
        difference: "-10.0"
      },
      peakExtension: {
        pro: "100.0",
        trainee: "80.0",
        difference: "-20.0"
      },
      wristDrop: {
        pro: "-60.0",
        trainee: "-45.0",
        difference: "15.0"
      }
    };

    return { comparison, phases, stats };
  };

  const normalizeAndAlign = (proMetrics, traineeMetrics) => {
    if (!proMetrics.wristHip.length || !traineeMetrics.wristHip.length) {
      return generateDemoNormalizedData();
    }

    const proAnchors = findAnchorPoints(proMetrics.wristHip);
    const traineeAnchors = findAnchorPoints(traineeMetrics.wristHip);

    if (!proAnchors || !traineeAnchors) {
      return generateDemoNormalizedData();
    }

    const normalizedComparison = {
      wristHip: [],
      shoulderRotation: [],
      weightTransfer: [],
      armExtension: []
    };

    for (let percent = 0; percent <= 100; percent += 2) {
      const proIndex = mapPercentToIndex(percent, proAnchors, proMetrics.wristHip.length);
      const traineeIndex = mapPercentToIndex(percent, traineeAnchors, traineeMetrics.wristHip.length);

      normalizedComparison.wristHip.push({
        strokePercent: percent,
        proValue: interpolateValue(proMetrics.wristHip, proIndex),
        traineeValue: interpolateValue(traineeMetrics.wristHip, traineeIndex)
      });

      normalizedComparison.shoulderRotation.push({
        strokePercent: percent,
        proValue: interpolateValue(proMetrics.shoulderRotation, proIndex),
        traineeValue: interpolateValue(traineeMetrics.shoulderRotation, traineeIndex)
      });

      normalizedComparison.weightTransfer.push({
        strokePercent: percent,
        proValue: interpolateValue(proMetrics.weightTransfer, proIndex),
        traineeValue: interpolateValue(traineeMetrics.weightTransfer, traineeIndex)
      });

      normalizedComparison.armExtension.push({
        strokePercent: percent,
        proValue: interpolateValue(proMetrics.armExtension, proIndex),
        traineeValue: interpolateValue(traineeMetrics.armExtension, traineeIndex)
      });
    }

    const phases = [
      { phase: 'Backswing', start: 0, end: 30, color: '#82ca9d' },
      { phase: 'Forward Swing', start: 30, end: 60, color: '#ff7300' },
      { phase: 'Contact', start: 60, end: 70, color: '#ff0000' },
      { phase: 'Follow-through', start: 70, end: 100, color: '#0088fe' }
    ];

    const stats = calculateComparisonStats(proMetrics, traineeMetrics, proAnchors, traineeAnchors);

    return {
      comparison: normalizedComparison,
      phases,
      stats
    };
  };

  const generateDynamicRecommendations = (stats, comparison) => {
    // Your existing generateDynamicRecommendations function with the default case added
    const recommendations = {
      priorities: [],
      strengths: [],
      drills: [],
      overallScore: 0
    };

    let scoreTotal = 0;
    let scoreCount = 0;

    // Analyze shoulder rotation
    const rotationDiff = parseFloat(stats.peakRotation.difference);
    if (rotationDiff < -15) {
      recommendations.priorities.push({
        severity: 'high',
        metric: 'Shoulder Rotation',
        issue: `Insufficient rotation (${Math.abs(rotationDiff).toFixed(0)}° less than optimal)`,
        detail: 'Limited shoulder turn reduces power generation and can lead to arm-dominant swings',
        improvement: 'Focus on turning your back to the target during backswing'
      });
      scoreTotal += 60;
    } else if (rotationDiff < -8) {
      recommendations.priorities.push({
        severity: 'medium',
        metric: 'Shoulder Rotation',
        issue: `Below optimal rotation (${Math.abs(rotationDiff).toFixed(0)}° less)`,
        detail: 'More rotation would increase power',
        improvement: 'Practice shadow swings with exaggerated shoulder turn'
      });
      scoreTotal += 75;
    } else if (rotationDiff > -5) {
      recommendations.strengths.push({
        metric: 'Shoulder Rotation',
        achievement: 'Excellent shoulder turn',
        detail: `Achieving ${stats.peakRotation.trainee}° rotation (pro level: ${stats.peakRotation.pro}°)`
      });
      scoreTotal += 95;
    } else {
      scoreTotal += 85;
    }
    scoreCount++;

    // Analyze wrist drop
    const wristDiff = parseFloat(stats.wristDrop.difference);
    if (wristDiff > 20) {
      recommendations.priorities.push({
        severity: 'high',
        metric: 'Wrist Position',
        issue: `Shallow wrist drop (${wristDiff.toFixed(0)}px higher than optimal)`,
        detail: 'Limited wrist drop reduces power and spin potential',
        improvement: 'Allow the paddle to drop naturally during backswing, creating lag'
      });
      scoreTotal += 65;
    } else if (wristDiff > 10) {
      recommendations.priorities.push({
        severity: 'medium',
        metric: 'Wrist Position',
        issue: `Wrist position could be lower`,
        detail: 'Deeper drop would improve power generation',
        improvement: 'Practice feeling the paddle weight during backswing'
      });
      scoreTotal += 80;
    } else {
      recommendations.strengths.push({
        metric: 'Wrist Mechanics',
        achievement: 'Good wrist lag',
        detail: 'Proper wrist position for power generation'
      });
      scoreTotal += 90;
    }
    scoreCount++;

    // Analyze weight transfer
    const weightTransferRange = Math.max(...comparison.weightTransfer.map(d => d.traineeValue)) -
                                Math.min(...comparison.weightTransfer.map(d => d.traineeValue));
    const optimalRange = Math.max(...comparison.weightTransfer.map(d => d.proValue)) -
                         Math.min(...comparison.weightTransfer.map(d => d.proValue));

    if (weightTransferRange < optimalRange * 0.6) {
      recommendations.priorities.push({
        severity: 'high',
        metric: 'Weight Transfer',
        issue: 'Limited weight shift',
        detail: 'Insufficient weight transfer reduces power and balance',
        improvement: 'Practice loading back foot, then driving forward through contact'
      });
      scoreTotal += 60;
    } else if (weightTransferRange < optimalRange * 0.8) {
      recommendations.priorities.push({
        severity: 'medium',
        metric: 'Weight Transfer',
        issue: 'Moderate weight transfer',
        detail: 'More dynamic weight shift would improve power',
        improvement: 'Exaggerate the back-to-front movement in practice'
      });
      scoreTotal += 75;
    } else {
      recommendations.strengths.push({
        metric: 'Weight Transfer',
        achievement: 'Dynamic weight shift',
        detail: 'Good transfer from back to front foot'
      });
      scoreTotal += 90;
    }
    scoreCount++;

    // Analyze arm extension
    const extensionDiff = parseFloat(stats.peakExtension.difference);
    if (extensionDiff < -25) {
      recommendations.priorities.push({
        severity: 'high',
        metric: 'Arm Extension',
        issue: `Limited extension (${Math.abs(extensionDiff).toFixed(0)} units less)`,
        detail: 'Incomplete extension reduces reach and power',
        improvement: 'Focus on extending through the ball toward your target'
      });
      scoreTotal += 65;
    } else if (extensionDiff < -15) {
      recommendations.priorities.push({
        severity: 'medium',
        metric: 'Arm Extension',
        issue: 'Could extend more fully',
        detail: 'Fuller extension improves control and power',
        improvement: 'Practice reaching toward target on follow-through'
      });
      scoreTotal += 80;
    } else {
      recommendations.strengths.push({
        metric: 'Arm Extension',
        achievement: 'Full extension through contact',
        detail: 'Good reach and follow-through'
      });
      scoreTotal += 95;
    }
    scoreCount++;

    // Analyze timing
    const timingDiff = parseFloat(stats.strokeDuration.difference);
    if (timingDiff > 300) {
      recommendations.priorities.push({
        severity: 'medium',
        metric: 'Stroke Tempo',
        issue: `Slow stroke execution (${timingDiff}ms slower)`,
        detail: 'Slower tempo may affect reaction time',
        improvement: 'Work on smoother, more efficient transitions'
      });
      scoreTotal += 70;
    } else if (timingDiff < 100) {
      recommendations.strengths.push({
        metric: 'Stroke Timing',
        achievement: 'Efficient tempo',
        detail: 'Quick, smooth execution'
      });
      scoreTotal += 95;
    } else {
      scoreTotal += 85;
    }
    scoreCount++;

    // Calculate overall score
    recommendations.overallScore = Math.round(scoreTotal / scoreCount);

    // Sort priorities by severity
    recommendations.priorities.sort((a, b) => {
      const severityOrder = { high: 0, medium: 1, low: 2 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });

    // Generate specific drills based on top priorities
    if (recommendations.priorities.length > 0) {
      const topPriorities = recommendations.priorities.slice(0, 3);

      topPriorities.forEach(priority => {
        switch(priority.metric) {
          case 'Shoulder Rotation':
            recommendations.drills.push({
              name: 'Wall Rotation Drill',
              description: 'Stand with back against wall, practice rotating shoulders while maintaining contact',
              reps: '3 sets of 15 reps'
            });
            break;
          case 'Wrist Position':
            recommendations.drills.push({
              name: 'Paddle Drop Drill',
              description: 'Practice letting paddle drop naturally during backswing, pause at lowest point',
              reps: '3 sets of 10 slow-motion swings'
            });
            break;
          case 'Weight Transfer':
            recommendations.drills.push({
              name: 'Step and Drive Drill',
              description: 'Practice stepping back, loading, then driving forward without hitting',
              reps: '3 sets of 12 reps'
            });
            break;
          case 'Arm Extension':
            recommendations.drills.push({
              name: 'Target Reach Drill',
              description: 'Place target cone 2 feet past contact point, practice reaching paddle to cone',
              reps: '3 sets of 15 swings'
            });
            break;
          case 'Stroke Tempo':
            recommendations.drills.push({
              name: 'Rhythm Training',
              description: 'Count "1-2-3" for backswing-forward-follow through, maintain consistent tempo',
              reps: '5 sets of 10 swings'
            });
            break;
          default:
            // No drill for this metric
            break;
        }
      });
    }

    return recommendations;
  };

  // Now define the functions that use the above helper functions

  const loadDemoComparison = () => {
    const demoData = generateDemoNormalizedData();
    setComparisonData(demoData.comparison);
    setPhaseMarkers(demoData.phases);
    setStatsComparison(demoData.stats);
    setTraineeFileName('Demo Trainee Data');

    // Generate dynamic recommendations based on the comparison
    const recommendations = generateDynamicRecommendations(demoData.stats, demoData.comparison);
    setDynamicRecommendations(recommendations);
  };

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setIsLoading(true);
    setTraineeFileName(file.name);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const traineeFrames = JSON.parse(e.target.result);

        // Get pro data
        const proFrames = getEmbeddedProData();

        // Extract metrics from both datasets
        const proMetrics = extractMetrics(proFrames, 'Pro');
        const traineeMetrics = extractMetrics(traineeFrames, 'Trainee');

        // Normalize and align the data
        const normalizedData = normalizeAndAlign(proMetrics, traineeMetrics);

        // Update state with real comparison
        setComparisonData(normalizedData.comparison);
        setPhaseMarkers(normalizedData.phases);
        setStatsComparison(normalizedData.stats);

        // Generate recommendations based on real data
        const recommendations = generateDynamicRecommendations(normalizedData.stats, normalizedData.comparison);
        setDynamicRecommendations(recommendations);

        setIsLoading(false);
      } catch (error) {
        console.error('Error parsing trainee data:', error);
        alert('Error loading file. Please ensure it\'s a valid JSON file with pose data.');
        setIsLoading(false);
      }
    };

    reader.readAsText(file);
  };

  // Initialize with demo data after component mounts
  useEffect(() => {
    loadDemoComparison();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the rest of your component code (CustomTooltip, getScoreColor, getSeverityColor, and the return JSX)
  const CustomTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-white p-2 border border-gray-300 rounded shadow-sm">
          <p className="font-semibold">Stroke Progress: {data.strokePercent}%</p>
          {payload.map((entry, index) => (
            <p key={`item-${index}`} style={{ color: entry.color }}>
              {entry.name}: {entry.value.toFixed(1)}
            </p>
          ))}
          {payload.length === 2 && (
            <p className="text-sm text-gray-600 mt-1">
              Difference: {(payload[1].value - payload[0].value).toFixed(1)}
            </p>
          )}
        </div>
      );
    }
    return null;
  };

  const getScoreColor = (score) => {
    if (score >= 90) return 'text-green-600';
    if (score >= 80) return 'text-blue-600';
    if (score >= 70) return 'text-yellow-600';
    return 'text-red-600';
  };

  const getSeverityColor = (severity) => {
    switch(severity) {
      case 'high': return 'bg-red-100 border-red-300';
      case 'medium': return 'bg-yellow-100 border-yellow-300';
      default: return 'bg-blue-100 border-blue-300';
    }
  };

  const hasData = comparisonData.wristHip.length > 0;

  // Keep all your existing JSX return statement
  return (
    <div className="p-4 bg-gray-50 min-h-screen">
      <h1 className="text-3xl font-bold mb-6">Volley Shot Analysis System</h1>

      {/* File Upload Section */}
      <div className="bg-white p-6 rounded-lg shadow mb-6">
        <h2 className="text-xl font-semibold mb-4">Load Trainee Data</h2>
        <div className="flex items-center gap-4">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleFileUpload}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition-colors"
            disabled={isLoading}
          >
            {isLoading ? 'Loading...' : 'Upload Trainee JSON'}
          </button>
          {traineeFileName && (
            <span className="text-sm text-gray-600">
              Current file: {traineeFileName}
            </span>
          )}
        </div>
        <p className="text-sm text-gray-500 mt-2">
          Upload a JSON file containing pickleball pose primitives to compare against the professional reference.
        </p>
        <div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded text-sm">
          <strong>Demo Mode:</strong> Currently showing example data. Upload different files to see how recommendations change.
        </div>
      </div>

      {/* Comparison Results */}
      {hasData && (
        <>
          {/* Overall Score Card */}
          {dynamicRecommendations && (
            <div className="bg-white p-6 rounded-lg shadow mb-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-2xl font-bold">Overall Performance Score</h2>
                <div className={`text-4xl font-bold ${getScoreColor(dynamicRecommendations.overallScore)}`}>
                  {dynamicRecommendations.overallScore}/100
                </div>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-4 mb-4">
                <div
                  className={`h-4 rounded-full transition-all duration-500 ${
                    dynamicRecommendations.overallScore >= 90 ? 'bg-green-500' :
                    dynamicRecommendations.overallScore >= 80 ? 'bg-blue-500' :
                    dynamicRecommendations.overallScore >= 70 ? 'bg-yellow-500' :
                    'bg-red-500'
                  }`}
                  style={{ width: `${dynamicRecommendations.overallScore}%` }}
                />
              </div>
              <p className="text-sm text-gray-600">
                {dynamicRecommendations.overallScore >= 90 ? 'Excellent technique! Minor refinements will perfect your stroke.' :
                 dynamicRecommendations.overallScore >= 80 ? 'Good fundamentals with room for improvement in key areas.' :
                 dynamicRecommendations.overallScore >= 70 ? 'Solid foundation. Focus on the priority areas below.' :
                 'Significant improvement opportunities. Work on fundamentals first.'}
              </p>
            </div>
          )}

          {/* Statistics */}
          {statsComparison && (
            <div className="bg-white p-4 rounded-lg shadow mb-6">
              <h2 className="text-xl font-semibold mb-3">Performance Metrics</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <h3 className="font-semibold text-sm text-gray-600">Stroke Duration</h3>
                  <p className="text-lg">Pro: {statsComparison.strokeDuration.pro}s</p>
                  <p className="text-lg">You: {statsComparison.strokeDuration.trainee}s</p>
                  <p className={`text-sm ${parseFloat(statsComparison.strokeDuration.difference) > 200 ? 'text-red-600' : 'text-green-600'}`}>
                    {parseFloat(statsComparison.strokeDuration.difference) > 0 ? '+' : ''}{statsComparison.strokeDuration.difference}ms
                  </p>
                </div>
                <div>
                  <h3 className="font-semibold text-sm text-gray-600">Peak Rotation</h3>
                  <p className="text-lg">Pro: {statsComparison.peakRotation.pro}°</p>
                  <p className="text-lg">You: {statsComparison.peakRotation.trainee}°</p>
                  <p className={`text-sm ${parseFloat(statsComparison.peakRotation.difference) < -5 ? 'text-red-600' : 'text-green-600'}`}>
                    {statsComparison.peakRotation.difference}°
                  </p>
                </div>
                <div>
                  <h3 className="font-semibold text-sm text-gray-600">Max Extension</h3>
                  <p className="text-lg">Pro: {statsComparison.peakExtension.pro}</p>
                  <p className="text-lg">You: {statsComparison.peakExtension.trainee}</p>
                  <p className={`text-sm ${parseFloat(statsComparison.peakExtension.difference) < -15 ? 'text-red-600' : 'text-green-600'}`}>
                    {statsComparison.peakExtension.difference} units
                  </p>
                </div>
                <div>
                  <h3 className="font-semibold text-sm text-gray-600">Wrist Drop</h3>
                  <p className="text-lg">Pro: {statsComparison.wristDrop.pro}px</p>
                  <p className="text-lg">You: {statsComparison.wristDrop.trainee}px</p>
                  <p className={`text-sm ${parseFloat(statsComparison.wristDrop.difference) > 10 ? 'text-red-600' : 'text-green-600'}`}>
                    {parseFloat(statsComparison.wristDrop.difference) > 0 ? '+' : ''}{statsComparison.wristDrop.difference}px
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Dynamic Recommendations */}
          {dynamicRecommendations && (
            <div className="bg-white p-6 rounded-lg shadow mb-6">
              <h2 className="text-xl font-semibold mb-4">Personalized Coaching Analysis</h2>

              {/* Priority Improvements */}
              {dynamicRecommendations.priorities.length > 0 && (
                <div className="mb-6">
                  <h3 className="font-semibold text-lg mb-3 text-red-600">Priority Areas for Improvement</h3>
                  <div className="space-y-3">
                    {dynamicRecommendations.priorities.map((priority, index) => (
                      <div key={index} className={`p-4 border rounded-lg ${getSeverityColor(priority.severity)}`}>
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <h4 className="font-semibold">{priority.metric}: {priority.issue}</h4>
                            <p className="text-sm mt-1">{priority.detail}</p>
                            <p className="text-sm mt-2 font-medium">💡 {priority.improvement}</p>
                          </div>
                          <span className={`text-xs px-2 py-1 rounded ${
                            priority.severity === 'high' ? 'bg-red-500 text-white' :
                            priority.severity === 'medium' ? 'bg-yellow-500 text-white' :
                            'bg-blue-500 text-white'
                          }`}>
                            {priority.severity.toUpperCase()}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Strengths */}
              {dynamicRecommendations.strengths.length > 0 && (
                <div className="mb-6">
                  <h3 className="font-semibold text-lg mb-3 text-green-600">Strengths to Maintain</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {dynamicRecommendations.strengths.map((strength, index) => (
                      <div key={index} className="p-3 bg-green-50 border border-green-200 rounded-lg">
                        <h4 className="font-semibold text-green-800">✓ {strength.metric}</h4>
                        <p className="text-sm text-green-700">{strength.achievement}</p>
                        <p className="text-xs text-green-600 mt-1">{strength.detail}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Recommended Drills */}
              {dynamicRecommendations.drills.length > 0 && (
                <div>
                  <h3 className="font-semibold text-lg mb-3 text-blue-600">Recommended Practice Drills</h3>
                  <div className="space-y-3">
                    {dynamicRecommendations.drills.map((drill, index) => (
                      <div key={index} className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                        <h4 className="font-semibold text-blue-800">{index + 1}. {drill.name}</h4>
                        <p className="text-sm text-blue-700 mt-1">{drill.description}</p>
                        <p className="text-xs text-blue-600 mt-2">📊 {drill.reps}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Charts Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Wrist-Hip Chart */}
            <div className="bg-white p-4 rounded-lg shadow">
              <h2 className="text-lg font-semibold mb-3">Wrist-Hip Vertical Differential</h2>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={comparisonData.wristHip} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="strokePercent"
                      type="number"
                      domain={[0, 100]}
                      label={{ value: 'Stroke Progress (%)', position: 'insideBottom', offset: -5 }}
                    />
                    <YAxis
                      label={{ value: 'Wrist Position (px)', angle: -90, position: 'insideLeft' }}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />

                    {phaseMarkers.map((phase, index) => (
                      <ReferenceLine
                        key={`phase-${index}`}
                        x={phase.start}
                        stroke={phase.color}
                        strokeDasharray="3 3"
                      />
                    ))}

                    <Line
                      type="monotone"
                      dataKey="proValue"
                      stroke="#8884d8"
                      strokeWidth={2}
                      name="Pro (Marek)"
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="traineeValue"
                      stroke="#ff6b6b"
                      strokeWidth={2}
                      strokeDasharray="5 5"
                      name="You"
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Shoulder Rotation Chart */}
            <div className="bg-white p-4 rounded-lg shadow">
              <h2 className="text-lg font-semibold mb-3">Shoulder Rotation</h2>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={comparisonData.shoulderRotation} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="strokePercent"
                      type="number"
                      domain={[0, 100]}
                      label={{ value: 'Stroke Progress (%)', position: 'insideBottom', offset: -5 }}
                    />
                    <YAxis
                      label={{ value: 'Rotation (°)', angle: -90, position: 'insideLeft' }}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />

                    {phaseMarkers.map((phase, index) => (
                      <ReferenceLine
                        key={`phase-${index}`}
                        x={phase.start}
                        stroke={phase.color}
                        strokeDasharray="3 3"
                      />
                    ))}

                    <Line
                      type="monotone"
                      dataKey="proValue"
                      stroke="#82ca9d"
                      strokeWidth={2}
                      name="Pro (Marek)"
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="traineeValue"
                      stroke="#ff6b6b"
                      strokeWidth={2}
                      strokeDasharray="5 5"
                      name="You"
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Weight Transfer Chart */}
            <div className="bg-white p-4 rounded-lg shadow">
              <h2 className="text-lg font-semibold mb-3">Weight Transfer</h2>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={comparisonData.weightTransfer} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="strokePercent"
                      type="number"
                      domain={[0, 100]}
                      label={{ value: 'Stroke Progress (%)', position: 'insideBottom', offset: -5 }}
                    />
                    <YAxis
                      label={{ value: 'Front Foot Weight (%)', angle: -90, position: 'insideLeft' }}
                      domain={[0, 100]}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />

                    {phaseMarkers.map((phase, index) => (
                      <ReferenceLine
                        key={`phase-${index}`}
                        x={phase.start}
                        stroke={phase.color}
                        strokeDasharray="3 3"
                      />
                    ))}

                    <ReferenceLine y={50} stroke="#666" strokeDasharray="3 3" label="Balanced" />

                    <Line
                      type="monotone"
                      dataKey="proValue"
                      stroke="#ff7300"
                      strokeWidth={2}
                      name="Pro (Marek)"
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="traineeValue"
                      stroke="#ff6b6b"
                      strokeWidth={2}
                      strokeDasharray="5 5"
                      name="You"
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Arm Extension Chart */}
            <div className="bg-white p-4 rounded-lg shadow">
              <h2 className="text-lg font-semibold mb-3">Arm Extension</h2>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={comparisonData.armExtension} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="strokePercent"
                      type="number"
                      domain={[0, 100]}
                      label={{ value: 'Stroke Progress (%)', position: 'insideBottom', offset: -5 }}
                    />
                    <YAxis
                      label={{ value: 'Extension (units)', angle: -90, position: 'insideLeft' }}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />

                    {phaseMarkers.map((phase, index) => (
                      <ReferenceLine
                        key={`phase-${index}`}
                        x={phase.start}
                        stroke={phase.color}
                        strokeDasharray="3 3"
                      />
                    ))}

                    <Line
                      type="monotone"
                      dataKey="proValue"
                      stroke="#0088fe"
                      strokeWidth={2}
                      name="Pro (Marek)"
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="traineeValue"
                      stroke="#ff6b6b"
                      strokeWidth={2}
                      strokeDasharray="5 5"
                      name="You"
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );


};

export default PickleballBackhandAnalysisV8;
