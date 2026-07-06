// 기본 CRUD 작업
import {
    db,
    appId,
    auth,
    callableFunctions,
    appCheckInitPromise,
    refreshAppCheckTokenBeforeFirestore
} from '../firebase.js';
import {
    doc,
    getDoc,
    setDoc,
    deleteDoc,
    updateDoc,
    deleteField,
    collection,
    addDoc,
    query,
    where,
    getDocs,
    writeBatch,
    runTransaction,
    increment
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { showToast } from '../ui.js';
import { logger } from '../utils.js';
import { getUserFacingErrorMessage } from '../utils/user-facing-error.js';
import { tryMarkAppOfflineFromNetworkFailure } from '../utils/network-reachability.js';

/**
 * 식사 저장 결과 — Callable(Admin) 폴백 시 Firestore 로컬 큐가 비지 않아 waitForPendingWrites·리스너 ack와 무관함.
 * @typedef {{ mealId: string, savedViaCallableFallback: boolean }} MealSaveResult
 */

/** @param {unknown} r @returns {MealSaveResult} */
export function unwrapMealSaveResult(r) {
    if (r && typeof r === 'object' && r.mealId != null) {
        return { mealId: String(r.mealId || ''), savedViaCallableFallback: !!r.savedViaCallableFallback };
    }
    if (r != null && typeof r !== 'object') {
        return { mealId: String(r), savedViaCallableFallback: false };
    }
    return { mealId: '', savedViaCallableFallback: false };
}
import { isDemoUser } from '../demo-account.js';
import {
    getDailyJournalFromSettings,
    normalizeDailyJournalEntry,
    dailyJournalHasContent,
    getDailyJournalMealDocId,
    dailyJournalEntryToMealDocument
} from '../utils/daily-journal-data.js';
import { isUserSettingsReadyForContentWrites } from '../utils/user-settings-write-guard.js';
import { normalizeNicknameForClaim, nicknameClaimDocId } from './nickname-claims.js';

/** Callable(httpsCallable) 오류 — 짧은 안내 문구만 */
function formatCallableErrorForToast(err) {
    const code = err && err.code != null ? String(err.code) : '';
    const raw = err && err.message != null ? String(err.message) : String(err || '');
    if (/unauthenticated|user-not-found/i.test(code + raw)) {
        return '다시 로그인한 뒤 시도해 주세요.';
    }
    if (/forbidden|app check/i.test(code + raw) && !/permission-denied/i.test(code)) {
        return '다시 로그인한 뒤 시도해 주세요.';
    }
    return getUserFacingErrorMessage(err, 'share');
}

/** Firestore에 undefined가 들어가면 쓰기 실패할 수 있어 제거 */
/**
 * Firestore 쓰기용: 반드시 auth.currentUser만 반환.
 * window.currentUser만 있고 auth가 비어 있으면 경로 uid는 맞아도 JWT가 안 붙어 permission-denied가 난다.
 */
async function resolveUserForFirestoreWrite() {
    const waitReady = async () => {
        try {
            if (auth && typeof auth.authStateReady === 'function') {
                await auth.authStateReady();
            }
        } catch (_) {
            /* ignore */
        }
    };
    await waitReady();
    let u = auth.currentUser;
    if (u && !u.isAnonymous) return u;
    await new Promise((r) => setTimeout(r, 120));
    await waitReady();
    u = auth.currentUser;
    if (u && !u.isAnonymous) return u;
    await new Promise((r) => setTimeout(r, 400));
    await waitReady();
    u = auth.currentUser;
    if (u && !u.isAnonymous) return u;

    const w = typeof window !== 'undefined' ? window.currentUser : null;
    if (w && !w.isAnonymous) {
        console.warn(
            '[dbOps] auth.currentUser 없음 — Firestore 쓰기에는 Firebase Auth JWT가 필요합니다. window만 있으면 항상 permission-denied입니다.'
        );
    }
    return null;
}

/**
 * 신규 meal 문서 ID 클라이언트 선발급 (오프라인 우선 저장용).
 * addDoc과 달리 서버 왕복 없이 즉시 ID가 확정되므로, 오프라인에서도
 * 낙관 레코드·삭제 큐잉·재시도(setDoc 멱등)가 모두 같은 ID로 동작한다.
 * @param {string} [uid]
 * @returns {string} 새 문서 ID ('' 반환 시 호출자가 temp 폴백)
 */
export function generateMealDocId(uid) {
    try {
        const userId = uid || auth.currentUser?.uid || (typeof window !== 'undefined' ? window.currentUser?.uid : null);
        if (!userId) return '';
        return doc(collection(db, 'artifacts', appId, 'users', userId, 'meals')).id;
    } catch (_) {
        return '';
    }
}

function stripUndefinedDeep(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'object') return value;
    if (value instanceof Date) return value;
    if (Array.isArray(value)) {
        return value.map(stripUndefinedDeep).filter((v) => v !== undefined);
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (v === undefined) continue;
        const next = stripUndefinedDeep(v);
        if (next !== undefined) out[k] = next;
    }
    return out;
}

async function bumpUserMealCount(uid, delta) {
    if (!uid || !delta) return;
    try {
        const userRef = doc(db, 'artifacts', appId, 'users', uid);
        await setDoc(userRef, { mealCount: increment(delta) }, { merge: true });
    } catch (e) {
        console.warn('mealCount 갱신 실패 (무시):', e?.message || e);
    }
}

export const dbOps = {
    /**
     * @param {object} record
     * @param {boolean} [silent]
     * @param {{ isNewRecord?: boolean }} [opts] — ID 선발급된 신규 문서 여부 (mealCount 증가용)
     * @returns {Promise<MealSaveResult>}
     */
    async save(record, silent = false, opts = {}) {
        let currentUser = await resolveUserForFirestoreWrite();
        if (auth.currentUser && window.currentUser && auth.currentUser.uid !== window.currentUser.uid) {
            logger.warn('[dbOps] auth/window UID 불일치 — auth 기준으로 저장', {
                authUid: auth.currentUser.uid,
                windowUid: window.currentUser.uid
            });
            currentUser = auth.currentUser;
        }
        if (!currentUser || currentUser.isAnonymous) {
            const error = new Error("로그인이 필요합니다.");
            showToast("저장 실패: 로그인이 필요합니다.", 'error');
            throw error;
        }
        if (!isDemoUser(currentUser) && !isUserSettingsReadyForContentWrites(window.userSettings)) {
            const msg = '약관 동의와 프로필(닉네임) 설정을 완료한 뒤 기록할 수 있습니다.';
            if (!silent) showToast(msg, 'error');
            throw new Error('ONBOARDING_INCOMPLETE');
        }
        try {
            const runWrite = async () => {
                // 오프라인에서 캐시 토큰이 만료돼 getIdToken이 실패해도 Firestore 로컬 큐잉은 가능해야 함 — 비치명 처리
                try {
                    if (typeof currentUser.getIdToken === 'function') {
                        await currentUser.getIdToken(false);
                    }
                } catch (tokenErr) {
                    console.warn('[dbOps] getIdToken 실패 (오프라인 큐잉 계속):', tokenErr?.code || tokenErr?.message || tokenErr);
                }
                await appCheckInitPromise;
                await refreshAppCheckTokenBeforeFirestore();

                const dataToSave = { ...record };
                const sanitizePhotoArray = (arr) => {
                    if (!Array.isArray(arr)) return [];
                    return arr.filter((photo) => {
                        if (typeof photo !== 'string' || !photo) return false;
                        return !photo.startsWith('data:image');
                    });
                };
                if (Object.prototype.hasOwnProperty.call(dataToSave, 'photos')) {
                    dataToSave.photos = sanitizePhotoArray(dataToSave.photos);
                }
                if (Object.prototype.hasOwnProperty.call(dataToSave, 'sharedPhotos')) {
                    dataToSave.sharedPhotos = sanitizePhotoArray(dataToSave.sharedPhotos);
                }
                // recordedAt: 서버 getDoc으로 보존하던 방식은 오프라인에서 저장 자체를 막음.
                // 호출자(saveEntry·재시도)가 기존 recordedAt을 record에 실어 보내므로 그 값을 신뢰한다.
                const callerRecordedAt =
                    typeof dataToSave.recordedAt === 'string' && dataToSave.recordedAt
                        ? dataToSave.recordedAt
                        : null;
                delete dataToSave.recordedAt;
                const docId = dataToSave.id;
                delete dataToSave.id;
                // sharedPhotos: sharedPhotos 컬렉션이 canonical — 클라이언트 meal 저장은 미러를 덮어쓰지 않음
                delete dataToSave.sharedPhotos;
                const cleaned = stripUndefinedDeep(dataToSave);
                cleaned.recordedAt = callerRecordedAt || new Date().toISOString();
                const coll = collection(db, 'artifacts', appId, 'users', currentUser.uid, 'meals');
                logger.log('식사 기록 저장 시도:', { userId: currentUser.uid, docId, dataToSave: cleaned });
                const mealPathHint = docId
                    ? `artifacts/${appId}/users/${currentUser.uid}/meals/${docId}`
                    : `artifacts/${appId}/users/${currentUser.uid}/meals/(addDoc)`;
                try {
                    if (docId) {
                        let preservedSharedPhotos;
                        try {
                            const existingSnap = await getDoc(doc(coll, docId));
                            if (existingSnap.exists() && Array.isArray(existingSnap.data()?.sharedPhotos)) {
                                preservedSharedPhotos = existingSnap.data().sharedPhotos;
                            }
                        } catch (_) {
                            /* 오프라인 등 — 기존 mealHistory 미러로 폴백 */
                            const fromHist = window.mealHistory?.find((m) => m && m.id === docId);
                            if (fromHist && Array.isArray(fromHist.sharedPhotos)) {
                                preservedSharedPhotos = fromHist.sharedPhotos;
                            }
                        }
                        if (preservedSharedPhotos !== undefined) {
                            cleaned.sharedPhotos = preservedSharedPhotos;
                        }
                        await setDoc(doc(coll, docId), cleaned);
                        // ID 선발급된 신규 문서: 오프라인 큐잉 중에도 hang 하지 않도록 비대기
                        if (opts.isNewRecord === true) void bumpUserMealCount(currentUser.uid, 1);
                        if (!silent) {
                            showToast("기록이 수정되었습니다.", 'success');
                        }
                        return { mealId: String(docId), savedViaCallableFallback: false };
                    }
                    const docRef = await addDoc(coll, cleaned);
                    void bumpUserMealCount(currentUser.uid, 1);
                    logger.log('식사 기록 저장 성공:', docRef.id);
                    if (!silent) {
                        showToast("식사가 기록되었습니다.", 'success');
                    }
                    return { mealId: docRef.id, savedViaCallableFallback: false };
                } catch (wErr) {
                    if (wErr?.code === 'permission-denied') {
                        // 직접 쓰기 실패는 흔히 App Check/WebChannel 이슈이며, 아래 Callable 폴백으로 정상 저장됨 → error로 찍지 않음
                        const msg = wErr?.message != null ? String(wErr.message) : '';
                        logger.warn('[dbOps] Firestore 직접 저장 불가 → 서버(saveArtifactUserMeal) 폴백 시도', {
                            path: mealPathHint,
                            appId,
                            uid: currentUser.uid,
                            firestoreCode: wErr?.code,
                            firestoreMessage: msg.length > 400 ? `${msg.slice(0, 400)}…` : msg
                        });
                        try {
                            let serializable;
                            try {
                                serializable = JSON.parse(JSON.stringify(cleaned));
                            } catch {
                                serializable = cleaned;
                            }
                            const res = await callableFunctions.saveArtifactUserMeal({
                                meal: serializable,
                                mealId: docId || null
                            });
                            const mid = res?.data?.mealId;
                            if (typeof mid === 'string' && mid) {
                                logger.log('[dbOps] saveArtifactUserMeal 폴백 성공:', mid);
                                if (!silent) {
                                    showToast(
                                        docId ? "기록이 수정되었습니다." : "식사가 기록되었습니다.",
                                        'success'
                                    );
                                }
                                return { mealId: mid, savedViaCallableFallback: true };
                            }
                        } catch (fbErr) {
                            logger.error('[dbOps] saveArtifactUserMeal 폴백 실패:', fbErr?.code || fbErr?.message || fbErr);
                        }
                    }
                    throw wErr;
                }
            };

            try {
                return await runWrite();
            } catch (e1) {
                if (e1?.code === 'permission-denied') {
                    logger.log('[dbOps] Firestore 직접 저장 재시도 1회 (토큰·App Check 갱신)');
                    currentUser = (await resolveUserForFirestoreWrite()) || currentUser;
                    if (typeof currentUser?.getIdToken === 'function') {
                        await currentUser.getIdToken(true);
                    }
                    await refreshAppCheckTokenBeforeFirestore({ force: true });
                    return await runWrite();
                }
                throw e1;
            }
        } catch (e) {
            tryMarkAppOfflineFromNetworkFailure(e);
            console.error("Save Error:", e);
            const currentUser = auth.currentUser || window.currentUser;
            console.error("저장 실패 상세:", { 
                userId: currentUser?.uid, 
                errorCode: e.code, 
                errorMessage: e.message 
            });
            if (!silent) {
                showToast(getUserFacingErrorMessage(e, 'save'), 'error');
            }
            throw e;
        }
    },
    async delete(id) {
        let currentUser = await resolveUserForFirestoreWrite();
        if (auth.currentUser && window.currentUser && auth.currentUser.uid !== window.currentUser.uid) {
            currentUser = auth.currentUser;
        }
        if (!currentUser || currentUser.isAnonymous) {
            const error = new Error("로그인이 필요합니다.");
            throw error;
        }
        if (isDemoUser(currentUser)) {
            showToast('샘플 계정에서는 삭제할 수 없습니다.', 'error');
            throw new Error('read-only-demo');
        }
        if (!id) {
            const error = new Error("삭제할 항목이 없습니다.");
            throw error;
        }
        const uid = currentUser.uid;
        const tryDeleteViaCallable = async () => {
            const res = await callableFunctions.deleteArtifactUserMeal({ mealId: id });
            const deleted = res?.data?.deleted === true;
            logger.log('[dbOps] deleteArtifactUserMeal 폴백:', deleted ? '삭제됨' : '문서 없음');
        };
        try {
            // 오프라인에서도 deleteDoc 로컬 큐잉이 가능하도록 토큰 갱신 실패는 비치명 처리
            try {
                if (typeof currentUser.getIdToken === 'function') {
                    await currentUser.getIdToken(false);
                }
            } catch (tokenErr) {
                console.warn('[dbOps] delete getIdToken 실패 (큐잉 계속):', tokenErr?.code || tokenErr?.message || tokenErr);
            }
            await appCheckInitPromise;
            await refreshAppCheckTokenBeforeFirestore();

            let deletedViaCallable = false;
            try {
                await deleteDoc(doc(db, 'artifacts', appId, 'users', uid, 'meals', id));
            } catch (docErr) {
                if (docErr?.code === 'permission-denied') {
                    await tryDeleteViaCallable();
                    deletedViaCallable = true;
                } else {
                    throw docErr;
                }
            }

            if (!deletedViaCallable) {
                await bumpUserMealCount(uid, -1);
                const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
                const sharedQuery = query(
                    sharedColl,
                    where('entryId', '==', id),
                    where('userId', '==', uid)
                );
                const sharedSnap = await getDocs(sharedQuery);
                if (!sharedSnap.empty) {
                    const batch = writeBatch(db);
                    sharedSnap.docs.forEach((d) => batch.delete(d.ref));
                    await batch.commit();
                }
            }
            // 성공 토스트는 호출자에서 표시
        } catch (e) {
            tryMarkAppOfflineFromNetworkFailure(e);
            console.error("Delete Error:", e);
            throw e;
        }
    },
    async saveSettings(newSettings) {
        const currentUser = auth.currentUser || window.currentUser;
        if (!currentUser || currentUser.isAnonymous) {
            showToast("설정 저장 실패: 로그인이 필요합니다.", 'error');
            return;
        }
        if (isDemoUser(currentUser)) {
            return;
        }
        try {
            // OAuth·커스텀 토큰 직후: 재시도 경로에서만 강제 갱신(연속 저장 체감 개선)
            if (typeof currentUser.getIdToken === 'function') {
                await currentUser.getIdToken(false);
            }
            await appCheckInitPromise;
            await refreshAppCheckTokenBeforeFirestore();
            // 기존 설정을 먼저 읽어서 profile 정보 보존
            let existingSettings = {};
            try {
                const existingDoc = await getDoc(doc(db, 'artifacts', appId, 'users', currentUser.uid, 'config', 'settings'));
                if (existingDoc.exists()) {
                    existingSettings = existingDoc.data();
                }
            } catch (e) {
                console.warn('기존 설정 읽기 실패 (무시하고 계속):', e);
            }
            
            // 새 설정과 기존 설정을 병합 (profile 정보 보존)
            const settingsToSave = { ...existingSettings, ...newSettings };
            
            // 프로필 정보 병합 (닉네임은 새 값이 있으면 업데이트, 없으면 기존 값 유지)
            if (newSettings.profile || existingSettings.profile) {
                // 닉네임을 제외한 프로필 정보 먼저 병합
                const { nickname: newNickname, ...newProfileWithoutNickname } = newSettings.profile || {};
                const { nickname: existingNickname, ...existingProfileWithoutNickname } = existingSettings.profile || {};
                
                settingsToSave.profile = {
                    ...existingProfileWithoutNickname,
                    ...newProfileWithoutNickname
                };
                
                // 닉네임 처리: 새 닉네임이 명시적으로 제공되고 유효하면 업데이트, 아니면 기존 값 유지
                // 단, 새 닉네임이 기본값('게스트')이고 기존 닉네임이 유효한 경우 기존 값 유지
                if (newNickname !== undefined && newNickname !== null && newNickname !== '' && newNickname !== '게스트') {
                    // 새 닉네임이 명시적으로 제공되고 기본값이 아닌 경우 업데이트
                    settingsToSave.profile.nickname = newNickname;
                    console.log('✅ 닉네임 업데이트:', { 
                        old: existingNickname, 
                        new: newNickname 
                    });
                } else if (existingNickname && existingNickname !== '게스트') {
                    // 기존 닉네임이 있고 기본값이 아니면 유지
                    settingsToSave.profile.nickname = existingNickname;
                } else if (existingNickname) {
                    // 기존 닉네임이 기본값이어도 일단 유지
                    settingsToSave.profile.nickname = existingNickname;
                } else if (!settingsToSave.profile.nickname) {
                    // 닉네임이 전혀 없을 때만 기본값 사용
                    settingsToSave.profile.nickname = '게스트';
                }
            } else if (!settingsToSave.profile) {
                // profile 자체가 없을 때만 기본값 설정
                settingsToSave.profile = { icon: '🐻', nickname: '게스트' };
            }
            
            // 중요: providerId와 email은 처음 로그인 시에만 설정되는 고정 항목입니다.
            // saveSettings에서는 기존 값만 보존하고, 절대 업데이트하지 않습니다.
            // providerId와 email은 약관 동의 또는 프로필 설정 시에만 설정됩니다.
            
            // 기존 설정에서 providerId와 email 보존 (새 설정에 포함되어 있지 않으면 기존 값 유지)
            if (existingSettings.providerId && !newSettings.providerId) {
                settingsToSave.providerId = existingSettings.providerId;
            }
            if (existingSettings.email && !newSettings.email) {
                settingsToSave.email = existingSettings.email;
            }
            
            const settingsPath = `artifacts/${appId}/users/${currentUser.uid}/config/settings`;
            console.log('💾 설정 저장 시도:', { 
                userId: currentUser.uid, 
                path: settingsPath,
                providerId: settingsToSave.providerId,
                email: settingsToSave.email,
                nickname: settingsToSave.profile?.nickname,
                hasProfile: !!settingsToSave.profile
            });
            const settingsRef = doc(db, 'artifacts', appId, 'users', currentUser.uid, 'config', 'settings');
            const claimsColl = collection(db, 'artifacts', appId, 'nicknameClaims');
            const normNew = normalizeNicknameForClaim(settingsToSave.profile?.nickname);
            const normOld = normalizeNicknameForClaim(existingSettings.profile?.nickname);
            /** 닉네임 정규화 값이 동일하면 클레임 이동 불필요 → 트랜잭션 생략(왕복·락 비용 감소) */
            const nicknameNormalizedUnchanged = normNew === normOld;

            const userRootRef = doc(db, 'artifacts', appId, 'users', currentUser.uid);
            const payloadForWrite = stripUndefinedDeep(settingsToSave);
            let savedViaFunctionsProxy = false;

            const doClientFirestoreWrite = async () => {
                try {
                    await setDoc(userRootRef, { uid: currentUser.uid }, { merge: true });
                } catch (e) {
                    console.warn('사용자 루트 문서 생성/갱신 실패 (설정 저장 계속):', e?.code || e?.message || e);
                }

                if (nicknameNormalizedUnchanged) {
                    await setDoc(settingsRef, payloadForWrite, { merge: true });
                    return;
                }

                await runTransaction(db, async (transaction) => {
                    /** Firestore: 트랜잭션 내 모든 read(get)은 write(set/delete)보다 먼저 실행되어야 함 */
                    const newClaimRef = normNew ? doc(claimsColl, nicknameClaimDocId(normNew)) : null;
                    const oldClaimRef =
                        normOld && normOld !== normNew ? doc(claimsColl, nicknameClaimDocId(normOld)) : null;

                    const newClaimSnap = newClaimRef ? await transaction.get(newClaimRef) : null;
                    const oldClaimSnap = oldClaimRef ? await transaction.get(oldClaimRef) : null;
                    let ownerSettingsSnap = null;
                    if (newClaimSnap && newClaimSnap.exists()) {
                        const owner = newClaimSnap.data()?.userId;
                        if (owner && owner !== currentUser.uid) {
                            const ownerSettingsRef = doc(
                                db,
                                'artifacts',
                                appId,
                                'users',
                                owner,
                                'config',
                                'settings'
                            );
                            ownerSettingsSnap = await transaction.get(ownerSettingsRef);
                        }
                    }

                    if (normNew && newClaimSnap && newClaimSnap.exists()) {
                        const owner = newClaimSnap.data()?.userId;
                        if (owner && owner !== currentUser.uid) {
                            const ownerNorm = normalizeNicknameForClaim(
                                ownerSettingsSnap && ownerSettingsSnap.exists()
                                    ? ownerSettingsSnap.data()?.profile?.nickname
                                    : null
                            );
                            if (ownerNorm === normNew) {
                                throw new Error('NICKNAME_TAKEN');
                            }
                            transaction.delete(newClaimRef);
                        }
                    }

                    if (
                        normOld &&
                        normOld !== normNew &&
                        oldClaimSnap &&
                        oldClaimSnap.exists() &&
                        oldClaimSnap.data()?.userId === currentUser.uid
                    ) {
                        transaction.delete(oldClaimRef);
                    }

                    transaction.set(settingsRef, payloadForWrite, { merge: true });

                    if (normNew && newClaimRef) {
                        transaction.set(newClaimRef, {
                            userId: currentUser.uid,
                            normalizedNickname: normNew,
                            displayNickname: String(settingsToSave.profile.nickname).trim(),
                            updatedAt: new Date().toISOString()
                        });
                    }
                });
            };

            try {
                await doClientFirestoreWrite();
            } catch (clientErr) {
                const errMsg = String(clientErr?.message || '').toLowerCase();
                const isPerm =
                    clientErr?.code === 'permission-denied' ||
                    clientErr?.code === 'PERMISSION_DENIED' ||
                    errMsg.includes('permission-denied') ||
                    errMsg.includes('insufficient permissions');
                if (isPerm && callableFunctions?.saveArtifactUserSettings) {
                    try {
                        if (typeof currentUser.getIdToken === 'function') {
                            await currentUser.getIdToken(true);
                        }
                        await refreshAppCheckTokenBeforeFirestore({ force: true });
                        const res = await callableFunctions.saveArtifactUserSettings({
                            settings: payloadForWrite
                        });
                        if (res?.data?.ok) {
                            savedViaFunctionsProxy = true;
                            console.log(
                                '✅ 설정 저장 성공 (Cloud Functions 프록시 — 클라이언트 Firestore/App Check 제한 우회)'
                            );
                        } else {
                            throw clientErr;
                        }
                    } catch (fe) {
                        const feCode = String(fe?.code || '');
                        const nicknameTaken =
                            feCode.includes('already-exists') ||
                            (fe?.message && String(fe.message).includes('닉네임'));
                        if (nicknameTaken) {
                            throw new Error('NICKNAME_TAKEN');
                        }
                        console.warn('saveArtifactUserSettings 폴백 실패:', fe?.code, fe?.message);
                        throw clientErr;
                    }
                } else {
                    throw clientErr;
                }
            }

            if (!savedViaFunctionsProxy) {
                console.log('✅ 설정 저장 성공:', {
                    providerId: settingsToSave.providerId,
                    email: settingsToSave.email,
                    nickname: settingsToSave.profile?.nickname
                });
            }

            if (
                typeof window !== 'undefined' &&
                typeof window.ensureUserRegistered === 'function' &&
                isUserSettingsReadyForContentWrites(settingsToSave)
            ) {
                try {
                    await window.ensureUserRegistered();
                } catch (eu) {
                    console.warn('ensureUserRegistered 후행 호출 실패 (무시):', eu?.message || eu);
                }
            }
        } catch (e) {
            tryMarkAppOfflineFromNetworkFailure(e);
            console.error("Settings Save Error:", e);
            const currentUser = auth.currentUser || window.currentUser;
            console.error("설정 저장 실패 상세:", { 
                userId: currentUser?.uid, 
                errorCode: e.code, 
                errorMessage: e.message 
            });
            if (e.message === 'NICKNAME_TAKEN') {
                showToast('이미 사용 중인 닉네임입니다.', 'error');
            } else {
                showToast(getUserFacingErrorMessage(e, 'settings'), 'error');
            }
            throw e;
        }
    },

    async saveDailyComment(date, comment) {
        const existing = this.getDailyJournal(date);
        await this.saveDailyJournal(date, {
            comment: comment != null ? String(comment) : '',
            photos: existing.photos,
            sharedPhotos: existing.sharedPhotos,
            photoAspectRatio: existing.photoAspectRatio,
            weightEnabled: existing.weightEnabled,
            bloodSugarEnabled: existing.bloodSugarEnabled,
            weightRecords: existing.weightRecords,
            bloodSugarRecords: existing.bloodSugarRecords,
            recordedAt: existing.recordedAt
        });
    },

    async syncDailyJournalMealMirror(date, entry) {
        const currentUser = auth.currentUser || window.currentUser;
        if (!currentUser?.uid || currentUser.isAnonymous || isDemoUser(currentUser)) return;
        const mealId = getDailyJournalMealDocId(date);
        if (!mealId) return;
        await refreshAppCheckTokenBeforeFirestore();
        const mealRef = doc(db, 'artifacts', appId, 'users', currentUser.uid, 'meals', mealId);
        const normalized = normalizeDailyJournalEntry(entry);
        if (!dailyJournalHasContent(normalized)) {
            try {
                const ex = await getDoc(mealRef);
                if (ex.exists()) await deleteDoc(mealRef);
            } catch (e) {
                console.warn('[dbOps] 하루기록 meals 미러 삭제 실패:', e?.code || e?.message || e);
            }
            return;
        }
        const mealDoc = dailyJournalEntryToMealDocument(date, normalized);
        delete mealDoc.id;
        try {
            const exSnap = await getDoc(mealRef);
            if (exSnap.exists() && exSnap.data()?.recordedAt != null) {
                mealDoc.recordedAt = exSnap.data().recordedAt;
            } else if (!mealDoc.recordedAt) {
                mealDoc.recordedAt = new Date().toISOString();
            }
            await setDoc(mealRef, stripUndefinedDeep(mealDoc));
        } catch (e) {
            console.error('[dbOps] 하루기록 meals 미러 저장 실패:', e);
            throw e;
        }
    },

    async saveDailyJournal(date, entry) {
        const currentUser = auth.currentUser || window.currentUser;
        if (!currentUser || currentUser.isAnonymous) {
            showToast('저장 실패: 로그인이 필요합니다.', 'error');
            return;
        }
        if (isDemoUser(currentUser)) {
            showToast('샘플 계정에서는 하루 기록을 저장할 수 없습니다.', 'error');
            return;
        }
        const normalized = normalizeDailyJournalEntry(entry);
        try {
            if (!window.userSettings.dailyComments) {
                window.userSettings.dailyComments = {};
            }
            if (dailyJournalHasContent(normalized)) {
                const prev = window.userSettings.dailyComments?.[date];
                const prevRecorded = prev ? normalizeDailyJournalEntry(prev).recordedAt : '';
                normalized.recordedAt = normalized.recordedAt || prevRecorded || new Date().toISOString();
                window.userSettings.dailyComments[date] = normalized;
            } else {
                delete window.userSettings.dailyComments[date];
            }
            await dbOps.saveSettings(window.userSettings);
            await dbOps.syncDailyJournalMealMirror(date, normalized);
        } catch (e) {
            console.error('Daily Journal Save Error:', e);
            throw e;
        }
    },

    getDailyJournal(date) {
        return getDailyJournalFromSettings(window.userSettings, date);
    },

    getDailyComment(date) {
        return this.getDailyJournal(date).comment || '';
    },

    getDailyVitals(date) {
        const raw = window.userSettings?.dailyVitals?.[date];
        if (!raw || typeof raw !== 'object') {
            return { weight: '', glucose: '', weightOn: false, glucoseOn: false };
        }
        return {
            weight: raw.weight != null && raw.weight !== '' ? String(raw.weight) : '',
            glucose: raw.glucose != null && raw.glucose !== '' ? String(raw.glucose) : '',
            weightOn: raw.weightOn === true,
            glucoseOn: raw.glucoseOn === true
        };
    },

    async saveDailyVitals(date, vitals) {
        const currentUser = auth.currentUser || window.currentUser;
        if (!currentUser || currentUser.isAnonymous) {
            showToast('저장 실패: 로그인이 필요합니다.', 'error');
            return;
        }
        if (isDemoUser(currentUser)) {
            showToast('샘플 계정에서는 하루 기록을 저장할 수 없습니다.', 'error');
            return;
        }
        if (!vitals || typeof vitals !== 'object') return;
        try {
            if (!window.userSettings.dailyVitals) {
                window.userSettings.dailyVitals = {};
            }
            const weight = String(vitals.weight ?? '').trim();
            const glucose = String(vitals.glucose ?? '').trim();
            const weightOn = vitals.weightOn === true;
            const glucoseOn = vitals.glucoseOn === true;
            const hasData = weightOn || glucoseOn || weight || glucose;
            if (!hasData) {
                delete window.userSettings.dailyVitals[date];
            } else {
                window.userSettings.dailyVitals[date] = { weight, glucose, weightOn, glucoseOn };
            }
            await dbOps.saveSettings(window.userSettings);
        } catch (e) {
            console.error('Daily Vitals Save Error:', e);
            throw e;
        }
    },
    
    // 공유 사진 추가 (Cloud Functions 사용 - 레이트 리밋 적용)
    async sharePhotos(photosToShare, mealData) {
        if (!window.currentUser) return;
        if (isDemoUser(window.currentUser)) {
            showToast('샘플 계정에서는 모먼트 공유를 변경할 수 없습니다.', 'error');
            throw new Error('read-only-demo');
        }
        if (!isUserSettingsReadyForContentWrites(window.userSettings)) {
            showToast('약관 동의와 프로필(닉네임) 설정을 완료한 뒤 공유할 수 있습니다.', 'error');
            throw new Error('ONBOARDING_INCOMPLETE');
        }

        // 공유 금지 체크
        if (mealData && mealData.shareBanned === true) {
            showToast("이 게시물은 공유가 금지되어 있습니다.", 'error');
            throw new Error("공유 금지된 게시물입니다.");
        }
        
        // photosToShare가 빈 배열이면 공유 해제 (기존 문서만 삭제)
        // photosToShare가 있으면 공유 설정 (기존 문서 삭제 + 새 문서 추가)
        
        try {
            await refreshAppCheckTokenBeforeFirestore();
            const result = await callableFunctions.sharePhotos({
                photosToShare: photosToShare || [],
                mealData: mealData || {}
            });
            
            const action = photosToShare && photosToShare.length > 0 ? '공유' : '공유 해제';
            console.log(`${action} 완료 (entryId: ${mealData?.id || 'null'}, 사진 수: ${photosToShare?.length || 0})`);
            return result.data;
        } catch (e) {
            console.error("Share Photos Error:", e);
            const msg = String(e?.message || e?.details || '');
            const isPerm =
                e?.code === 'permission-denied' ||
                /permission|app check|forbidden/i.test(msg);
            if (isPerm) {
                try {
                    await refreshAppCheckTokenBeforeFirestore({ force: true });
                    await new Promise((r) => setTimeout(r, 400));
                    const result = await callableFunctions.sharePhotos({
                        photosToShare: photosToShare || [],
                        mealData: mealData || {}
                    });
                    const action = photosToShare && photosToShare.length > 0 ? '공유' : '공유 해제';
                    console.log(`${action} 완료 (재시도, entryId: ${mealData?.id || 'null'})`);
                    return result.data;
                } catch (e2) {
                    console.error('Share Photos 재시도 실패:', e2);
                }
            }
            showToast(formatCallableErrorForToast(e), 'error');
            throw e;
        }
    },
    // 공유 사진 해제 (Cloud Functions 사용)
    /** @param {{ mealEntryId: string, mealSharedPhotos: string[] } | null} [mealSync] 일반 식사 공유 취소 시 서버에서 meals.sharedPhotos 병합(클라 setDoc 생략) */
    async unsharePhotos(photos, entryId, isBestShare = false, isDailyShare = false, isInsightShare = false, mealSync = null) {
        if (!window.currentUser || !photos || photos.length === 0) return;
        if (isDemoUser(window.currentUser)) {
            showToast('샘플 계정에서는 공유를 해제할 수 없습니다.', 'error');
            throw new Error('read-only-demo');
        }
        try {
            const payload = {
                photos,
                entryId,
                isBestShare,
                isDailyShare,
                isInsightShare
            };
            if (
                mealSync &&
                typeof mealSync.mealEntryId === 'string' &&
                mealSync.mealEntryId.trim() &&
                Array.isArray(mealSync.mealSharedPhotos)
            ) {
                payload.mealEntryId = mealSync.mealEntryId.trim();
                payload.mealSharedPhotos = mealSync.mealSharedPhotos;
            }
            const result = await callableFunctions.unsharePhotos(payload);
            return result.data;
        } catch (e) {
            console.error("Unshare Photos Error:", e);
            showToast(formatCallableErrorForToast(e), 'error');
            throw e;
        }
    },
    
    // 사용자 데이터 삭제 (탈퇴용)
    async deleteAllUserData() {
        if (!window.currentUser || window.currentUser.isAnonymous) {
            throw new Error("로그인이 필요합니다.");
        }
        
        const userId = window.currentUser.uid;

        const deleteDocsInBatches = async (collRef, label) => {
            const snap = await getDocs(collRef);
            const max = 500;
            for (let i = 0; i < snap.docs.length; i += max) {
                const batch = writeBatch(db);
                snap.docs.slice(i, i + max).forEach((d) => batch.delete(d.ref));
                await batch.commit();
            }
            if (snap.docs.length) {
                console.log(`🗑️ 탈퇴: ${label} ${snap.docs.length}건 삭제`);
            }
        };

        try {
            const settingsRef = doc(db, 'artifacts', appId, 'users', userId, 'config', 'settings');
            const settingsSnap = await getDoc(settingsRef);
            const normNick = settingsSnap.exists()
                ? normalizeNicknameForClaim(settingsSnap.data()?.profile?.nickname)
                : null;

            // 1. 모든 meals 삭제 (500건 초과 시 배치 분할)
            const mealsColl = collection(db, 'artifacts', appId, 'users', userId, 'meals');
            await deleteDocsInBatches(mealsColl, 'meals');

            // 1b. 연도별 dailyStats — 통계·트래커 달력·출석 등에 사용 (meals만 지우면 서버에 잔존)
            const statsYearsColl = collection(db, 'artifacts', appId, 'users', userId, 'config', 'stats', 'years');
            await deleteDocsInBatches(statsYearsColl, 'config/stats/years');
            const statsParentRef = doc(db, 'artifacts', appId, 'users', userId, 'config', 'stats');
            try {
                await deleteDoc(statsParentRef);
            } catch (e) {
                console.warn('탈퇴: config/stats 문서 삭제 스킵:', e?.code || e?.message || e);
            }

            // 1c. 피드 알림 서브컬렉션
            const feedNotifColl = collection(db, 'artifacts', appId, 'users', userId, 'feedNotifications');
            await deleteDocsInBatches(feedNotifColl, 'feedNotifications');

            // 1d. 기타 config 단일 문서
            for (const docId of ['reportedPosts', 'fcmTokens']) {
                try {
                    await deleteDoc(doc(db, 'artifacts', appId, 'users', userId, 'config', docId));
                } catch (e) {
                    console.warn(`탈퇴: config/${docId} 삭제 스킵:`, e?.code || e?.message || e);
                }
            }
            
            // 2. 닉네임 클레임 제거 (설정 삭제 전, 탈퇴 후에도 닉 재사용 가능하도록)
            if (normNick) {
                const claimRef = doc(db, 'artifacts', appId, 'nicknameClaims', nicknameClaimDocId(normNick));
                try {
                    const cSnap = await getDoc(claimRef);
                    if (cSnap.exists() && cSnap.data()?.userId === userId) {
                        await deleteDoc(claimRef);
                    }
                } catch (e) {
                    console.warn('nickname claim 삭제 실패 (무시하고 계속):', e?.code || e?.message || e);
                }
            }

            // 3. settings 삭제
            await deleteDoc(settingsRef);
            
            // 4. 공유된 사진 삭제
            const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
            const sharedQuery = query(sharedColl, where('userId', '==', userId));
            const sharedSnapshot = await getDocs(sharedQuery);
            const sharedBatch = writeBatch(db);
            sharedSnapshot.docs.forEach(docSnap => {
                sharedBatch.delete(docSnap.ref);
            });
            if (sharedSnapshot.docs.length > 0) {
                await sharedBatch.commit();
            }
            
            // 5. 프로필 사진 삭제 (Storage)
            if (window.userSettings?.profile?.photoUrl) {
                try {
                    const { storage } = await import('../firebase.js');
                    const { ref, deleteObject } = await import("https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js");
                    // photoUrl에서 경로 추출
                    const photoUrl = window.userSettings.profile.photoUrl;
                    const urlMatch = photoUrl.match(/users%2F([^%]+)%2Fprofile%2F(.+)/);
                    if (urlMatch) {
                        const photoPath = `users/${userId}/profile/${urlMatch[2]}`;
                        const photoRef = ref(storage, photoPath);
                        await deleteObject(photoRef);
                    }
                } catch (storageError) {
                    console.warn('프로필 사진 삭제 중 오류 (무시하고 계속 진행):', storageError);
                }
            }

            // 6. users 루트의 mealCount 등 집계 필드 제거(재가입 전까지 문서가 남는 경우 대비)
            const userRootRef = doc(db, 'artifacts', appId, 'users', userId);
            try {
                const rootSnap = await getDoc(userRootRef);
                if (rootSnap.exists()) {
                    // 동일 UID 문자열 재가입(카카오 커스텀 등) 시 이전 가입일이 남지 않도록 제거
                    await updateDoc(userRootRef, { mealCount: deleteField(), createdAt: deleteField() });
                }
            } catch (e) {
                console.warn('탈퇴: users 루트 mealCount·createdAt 제거 스킵:', e?.code || e?.message || e);
            }

            if (typeof window !== 'undefined') {
                window.dailyStats = {};
                window.mealHistory = [];
            }
        } catch (e) {
            console.error("Delete All User Data Error:", e);
            throw e;
        }
    },

    /** main 끼니 중복 문서 정리 (Callable 호출) */
    async removeDuplicateMeals() {
        const currentUser = auth.currentUser || window.currentUser;
        if (!currentUser || currentUser.isAnonymous) return { deletedCount: 0 };
        try {
            const result = await callableFunctions.removeDuplicateMeals();
            const data = result?.data;
            const deletedCount = data?.deletedCount ?? 0;
            if (deletedCount > 0) {
                logger.log('removeDuplicateMeals 완료:', { deletedCount });
            }
            return data || { success: true, deletedCount: 0 };
        } catch (e) {
            console.error("removeDuplicateMeals Error:", e);
            return { success: false, deletedCount: 0 };
        }
    }
};
