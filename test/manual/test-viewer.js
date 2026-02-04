/**
 * Standalone test: HTTP + WebSocket server with simulated messages
 * Usage: node test/manual/test-viewer.js
 * Then open http://localhost:3000 in browser
 */

const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3456;
const app = express();

// Serve viewer static files
const viewerPath = path.join(__dirname, '..', '..', 'viewer');
app.use(express.static(viewerPath));

app.get('/', (_req, res) => {
  res.sendFile(path.join(viewerPath, 'index.html'));
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', mode: 'test' });
});

app.get('/download', (_req, res) => {
  res.status(200).send('Download test OK');
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Test data
const testNotebook = {
  fileName: 'test_statistics.ipynb',
  cells: [
    {
      kind: 'markup',
      source: '# 기초 통계학\n## 평균과 표준편차\n\n수식 테스트: $\\bar{x} = \\frac{1}{n}\\sum x_i$',
      languageId: 'markdown',
      outputs: [],
    },
    {
      kind: 'code',
      source: 'import numpy as np\n\ndata = [23, 45, 67, 89, 12, 34, 56]\nmean = np.mean(data)\nprint(f"평균: {mean:.2f}")',
      languageId: 'python',
      outputs: [
        { items: [{ mime: 'text/plain', data: '평균: 46.57' }] }
      ],
      executionOrder: 1,
    },
    {
      kind: 'code',
      source: 'print("Hello, World!")',
      languageId: 'python',
      outputs: [
        { items: [{ mime: 'text/plain', data: 'Hello, World!' }] }
      ],
      executionOrder: 2,
    },
  ],
  activeCellIndex: 1,
};

const testPython = {
  fileName: 'example.py',
  content: `import numpy as np
import pandas as pd

# 데이터 생성
data = [23, 45, 67, 89, 12, 34, 56]

def calculate_stats(data):
    """통계량 계산"""
    mean = np.mean(data)
    std = np.std(data)
    return mean, std

mean, std = calculate_stats(data)
print(f"평균: {mean:.2f}, 표준편차: {std:.2f}")

# DataFrame 생성
df = pd.DataFrame({'value': data})
print(df.describe())
`,
  languageId: 'python',
};

const testMarkdown = {
  fileName: 'README.md',
  content: `# 프로젝트 소개

## 개요

이 프로젝트는 **Jupyter Live Share** Extension입니다.

## 수식

인라인 수식: $E = mc^2$

블록 수식:

$$\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}$$

## 코드 예시

\`\`\`python
import numpy as np
data = np.random.randn(100)
print(f"평균: {data.mean():.4f}")
\`\`\`

## 목록

- 항목 1
- 항목 2
  - 하위 항목 A
  - 하위 항목 B
- 항목 3

## 표

| 이름 | 점수 | 등급 |
|------|------|------|
| 김철수 | 95 | A |
| 이영희 | 87 | B |
| 박민수 | 92 | A |
`,
  languageId: 'markdown',
};

const testPlainText = {
  fileName: 'notes.txt',
  content: `통계학 수업 노트
================

1. 기술통계
   - 평균 (Mean)
   - 중앙값 (Median)
   - 표준편차 (Standard Deviation)

2. 추론통계
   - 가설검정 (Hypothesis Testing)
   - 신뢰구간 (Confidence Interval)
   - p-value

3. 회귀분석
   - 단순 선형 회귀
   - 다중 회귀
   - 로지스틱 회귀

참고: 다음 수업에서 Python 실습 예정
`,
  languageId: 'plaintext',
};

// Test scenario queue
const scenarios = [
  { name: 'notebook', type: 'notebook:full', data: testNotebook, delay: 0 },
  { name: 'python', type: 'document:full', data: testPython, delay: 8000 },
  { name: 'markdown', type: 'document:full', data: testMarkdown, delay: 16000 },
  { name: 'plaintext', type: 'document:full', data: testPlainText, delay: 24000 },
];

let currentScenarioIndex = 0;
let clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS] Client connected (total: ${clients.size})`);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'join') {
        ws.send(JSON.stringify({ type: 'join:result', data: { success: true } }));
        ws.send(JSON.stringify({ type: 'viewers:count', data: { count: clients.size } }));

        // Send current scenario
        const scenario = scenarios[currentScenarioIndex];
        ws.send(JSON.stringify({ type: scenario.type, data: scenario.data }));
        console.log(`[WS] Sent ${scenario.type} (${scenario.name}) to new client`);
      }
    } catch (e) {
      console.error('[WS] Parse error:', e.message);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected (total: ${clients.size})`);
  });
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

server.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  Test Server Running on port ${PORT}`);
  console.log(`  Open: http://localhost:${PORT}`);
  console.log(`========================================\n`);
  console.log(`Test scenarios (auto-rotate every 8s):`);
  console.log(`  1. notebook:full  - test_statistics.ipynb`);
  console.log(`  2. document:full  - example.py (Python)`);
  console.log(`  3. document:full  - README.md (Markdown)`);
  console.log(`  4. document:full  - notes.txt (Plain text)`);
  console.log(`\nPress Ctrl+C to stop.\n`);

  // Auto-rotate scenarios
  let rotateIndex = 1;
  setInterval(() => {
    currentScenarioIndex = rotateIndex % scenarios.length;
    const scenario = scenarios[currentScenarioIndex];
    console.log(`[Auto] Switching to: ${scenario.name} (${scenario.type})`);
    broadcast(scenario.type, scenario.data);
    rotateIndex++;
  }, 8000);

  // Simulate cell update after 4s
  setTimeout(() => {
    if (currentScenarioIndex === 0) {
      console.log('[Auto] Simulating cell:update on cell 1');
      broadcast('cell:update', {
        index: 1,
        source: 'import numpy as np\n\ndata = [23, 45, 67, 89, 12, 34, 56, 78]\nmean = np.mean(data)\nstd = np.std(data)\nprint(f"평균: {mean:.2f}, 표준편차: {std:.2f}")',
      });
    }
  }, 4000);

  // Simulate document:update for python after 12s
  setTimeout(() => {
    console.log('[Auto] Simulating document:update for Python file');
    broadcast('document:update', {
      content: testPython.content + '\n# 추가된 코드\nfor i in range(10):\n    print(f"값 {i}: {data[i % len(data)]}")\n',
    });
  }, 12000);
});
