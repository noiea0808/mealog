#!/usr/bin/env node
/**
 * @capacitor/push-notifications Android: getToken 실패 시 getException()이 null이면 NPE로 앱이 종료될 수 있음 → 방어
 */
const fs = require('fs');
const path = require('path');

const file = path.join(
  __dirname,
  '..',
  'node_modules',
  '@capacitor',
  'push-notifications',
  'android',
  'src',
  'main',
  'java',
  'com',
  'capacitorjs',
  'plugins',
  'pushnotifications',
  'PushNotificationsPlugin.java'
);

if (!fs.existsSync(file)) {
  process.exit(0);
}

let content = fs.readFileSync(file, 'utf8');
const marker = 'Exception ex = task.getException()';
if (content.includes(marker)) {
  process.exit(0);
}

const buggy = `                if (!task.isSuccessful()) {
                    sendError(task.getException().getLocalizedMessage());
                    return;
                }`;

const fixed = `                if (!task.isSuccessful()) {
                    Exception ex = task.getException();
                    sendError(ex != null ? ex.getLocalizedMessage() : "FCM getToken failed");
                    return;
                }`;

if (!content.includes(buggy)) {
  console.warn('[patch-push-notifications-npe] 예상 패턴 없음 — Capacitor 버전 확인:', file);
  process.exit(0);
}

content = content.split(buggy).join(fixed);
fs.writeFileSync(file, content);
console.log('✅ PushNotificationsPlugin FCM getToken NPE 패치 적용');
