/**
 * DataService - 解耦的背单词数据访问层
 * 
 * 设计规范：
 * 1. 所有方法均返回 Promise，强制使用 async/await 规范调用。
 * 2. 当前阶段：底层基于 LocalStorage + 内存种子数据（INITIAL_VOCABULARY）实现本地离线持久化。
 * 3. 后期迁移：只需在对应函数内部切换为 Supabase 客户端调用（如 supabase.from('words').select()），
 *    而外部上层 UI、算法及视图层代码 0 修改无缝兼容！
 */

const OLD_STORAGE_KEY = 'bubei_vocabulary_v1';
const STORAGE_KEY = 'bubei_academic_vocab_v2';

/**
 * ---------------- Supabase 云端同步配置与服务 ----------------
 */
const SUPABASE_CONFIG = {
  url: 'https://abzacuzhggyvlqwwtlyj.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFiemFjdXpoZ2d5dmxxd3d0bHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyODE5NzIsImV4cCI6MjEwNDg1Nzk3Mn0.cZ6o_p7maiPH18KtuBBSRWfwDmC8Eb1j6ePIi7aBWuE'
};

const SupabaseService = {
  client: null,
  isInitialized: false,
  connectionState: 'idle', // 'idle' | 'connected' | 'table_missing' | 'error'

  getClient() {
    if (this.client) return this.client;
    if (typeof window !== 'undefined' && window.supabase && window.supabase.createClient) {
      try {
        this.client = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
        this.isInitialized = true;
      } catch (e) {
        console.warn('[SupabaseService] 初始化客户端异常:', e);
      }
    }
    return this.client;
  },

  /**
   * 检测 Supabase 连接状态与数据表就绪情况
   */
  async checkConnection() {
    const client = this.getClient();
    if (!client) {
      this.connectionState = 'error';
      return { ok: false, state: 'sdk_missing', message: 'Supabase SDK 尚未加载或当前处于离线模式' };
    }

    try {
      // 探测 words 表
      const { data, error, count } = await client
        .from('words')
        .select('id', { count: 'exact', head: true });

      if (error) {
        if (error.code === 'PGRST205' || (error.message && error.message.includes('schema cache'))) {
          this.connectionState = 'table_missing';
          return { ok: false, state: 'table_missing', message: '已成功连通 Supabase！但数据表尚未初始化，请先在 Supabase SQL Editor 中执行建表' };
        }
        this.connectionState = 'error';
        return { ok: false, state: 'error', message: error.message || '连接异常' };
      }

      this.connectionState = 'connected';
      return { ok: true, state: 'connected', cloudCount: count || 0, message: '云端数据库连接正常' };
    } catch (err) {
      this.connectionState = 'error';
      return { ok: false, state: 'error', message: err.message || '网络连接异常' };
    }
  },

  /**
   * 同步单个单词到云端（异步静默执行，不阻塞本地）
   */
  async syncWord(word) {
    const client = this.getClient();
    if (!client || this.connectionState === 'table_missing') return;
    try {
      const payload = {
        id: word.id,
        word: word.word,
        phonetic: word.phonetic || '',
        partOfSpeech: word.partOfSpeech || 'n.',
        definition: word.definition || '',
        exampleEn: word.exampleEn || '',
        exampleCn: word.exampleCn || '',
        tags: Array.isArray(word.tags) ? word.tags : [],
        status: word.status || 'new',
        reviewCount: Number(word.reviewCount) || 0,
        interval: Number(word.interval) || 0,
        nextReviewDate: Number(word.nextReviewDate) || Date.now(),
        lastReviewedAt: word.lastReviewedAt || null,
        userNotes: word.userNotes || '',
        createdAt: word.createdAt || Date.now(),
        lastModifiedAt: word.lastModifiedAt || Date.now()
      };
      await client.from('words').upsert(payload, { onConflict: 'id' });
    } catch (e) {
      console.warn('[SupabaseService] 单词同步静默捕获:', e);
    }
  },

  /**
   * 从云端删除单词
   */
  async deleteWord(id) {
    const client = this.getClient();
    if (!client || this.connectionState === 'table_missing') return;
    try {
      await client.from('words').delete().eq('id', id);
    } catch (e) {
      console.warn('[SupabaseService] 删除单词同步静默捕获:', e);
    }
  },

  /**
   * 同步统计与打卡数据到云端
   */
  async syncStats(stats) {
    const client = this.getClient();
    if (!client || this.connectionState === 'table_missing') return;
    try {
      const payload = {
        id: 'global_user_stats',
        dailyCounts: stats.dailyCounts || {},
        checkInDates: stats.checkInDates || [],
        bestStreak: Number(stats.bestStreak) || 0,
        lastActiveDate: stats.lastActiveDate || '',
        updatedAt: Date.now()
      };
      await client.from('study_stats').upsert(payload, { onConflict: 'id' });
    } catch (e) {
      console.warn('[SupabaseService] 打卡数据同步静默捕获:', e);
    }
  },

  /**
   * 分批全量推送本地数据到云端
   * @param {(progress: { percent: number, current: number, total: number }) => void} [onProgress]
   */
  async pushAllToCloud(onProgress) {
    const client = this.getClient();
    if (!client) throw new Error('Supabase 客户端尚未初始化');

    const words = await DataService.getWords();
    const stats = StatsService.getStats();

    // 1. 同步学习打卡记录
    await this.syncStats(stats);

    // 2. 分批次同步全部词汇（每批 200 词，兼顾速度与稳定性）
    const batchSize = 200;
    const total = words.length;

    for (let i = 0; i < total; i += batchSize) {
      const batch = words.slice(i, i + batchSize).map(w => ({
        id: w.id,
        word: w.word,
        phonetic: w.phonetic || '',
        partOfSpeech: w.partOfSpeech || 'n.',
        definition: w.definition || '',
        exampleEn: w.exampleEn || '',
        exampleCn: w.exampleCn || '',
        tags: Array.isArray(w.tags) ? w.tags : [],
        status: w.status || 'new',
        reviewCount: Number(w.reviewCount) || 0,
        interval: Number(w.interval) || 0,
        nextReviewDate: Number(w.nextReviewDate) || Date.now(),
        lastReviewedAt: w.lastReviewedAt || null,
        userNotes: w.userNotes || '',
        createdAt: w.createdAt || Date.now(),
        lastModifiedAt: w.lastModifiedAt || Date.now()
      }));

      const { error } = await client.from('words').upsert(batch, { onConflict: 'id' });
      if (error) throw error;

      const current = Math.min(i + batchSize, total);
      if (typeof onProgress === 'function') {
        onProgress({
          percent: Math.round((current / total) * 100),
          current,
          total
        });
      }
    }

    return { total };
  },

  /**
   * 从云端拉取全量数据并合并到本地
   */
  async pullAllFromCloud() {
    const client = this.getClient();
    if (!client) throw new Error('Supabase 客户端尚未初始化');

    // 1. 拉取打卡记录
    try {
      const { data: statsData } = await client
        .from('study_stats')
        .select('*')
        .eq('id', 'global_user_stats')
        .single();

      if (statsData) {
        const localStats = StatsService.getStats();
        const mergedCheckIns = Array.from(new Set([...(localStats.checkInDates || []), ...(statsData.checkInDates || [])])).sort();
        const mergedCounts = { ...(localStats.dailyCounts || {}), ...(statsData.dailyCounts || {}) };
        const mergedStreak = Math.max(localStats.bestStreak || 0, statsData.bestStreak || 0);
        const newStats = {
          dailyCounts: mergedCounts,
          checkInDates: mergedCheckIns,
          bestStreak: mergedStreak,
          lastActiveDate: statsData.lastActiveDate || localStats.lastActiveDate
        };
        StatsService.saveStats(newStats);
      }
    } catch (e) {
      console.warn('[SupabaseService] 拉取打卡记录警告:', e);
    }

    // 2. 分页拉取云端词库
    let allCloudWords = [];
    let from = 0;
    const step = 1000;

    while (true) {
      const { data, error } = await client
        .from('words')
        .select('*')
        .range(from, from + step - 1);

      if (error) throw error;
      if (!data || data.length === 0) break;
      allCloudWords.push(...data);
      if (data.length < step) break;
      from += step;
    }

    if (allCloudWords.length === 0) {
      return { total: 0, added: 0, updated: 0 };
    }

    // 标准化数据格式并安全合并至本地
    const normalized = allCloudWords.map(item => ({
      id: item.id,
      word: item.word,
      phonetic: item.phonetic || '',
      partOfSpeech: item.partOfSpeech || item.part_of_speech || 'n.',
      definition: item.definition || '',
      exampleEn: item.exampleEn || item.example_en || '',
      exampleCn: item.exampleCn || item.example_cn || '',
      tags: Array.isArray(item.tags) ? item.tags : [],
      status: item.status || 'new',
      reviewCount: Number(item.reviewCount || item.review_count) || 0,
      interval: Number(item.interval) || 0,
      nextReviewDate: Number(item.nextReviewDate || item.next_review_date) || Date.now(),
      lastReviewedAt: item.lastReviewedAt || item.last_reviewed_at || null,
      userNotes: item.userNotes || item.user_notes || '',
      createdAt: item.createdAt || item.created_at || Date.now()
    }));

    const result = await DataService.importBackup(normalized, 'merge');
    return {
      total: allCloudWords.length,
      added: result.added,
      updated: result.updated
    };
  }
};

const DataService = {
  /**
   * 初始化存储数据（如果 LocalStorage 中无数据，则使用 INITIAL_VOCABULARY 自动填充）
   * 支持从旧版 15 词版本平滑迁移用户自建词汇与笔记
   * @returns {Promise<void>}
   */
  async init() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) {
        // 尝试从旧版本存储迁移用户个性化记录与生词
        const oldStored = localStorage.getItem(OLD_STORAGE_KEY);
        const userNotesMap = new Map();
        const userStatusMap = new Map();
        const customWords = [];

        if (oldStored) {
          try {
            const oldList = JSON.parse(oldStored);
            if (Array.isArray(oldList)) {
              oldList.forEach(w => {
                if (w && w.word) {
                  const key = w.word.toLowerCase();
                  if (w.userNotes) userNotesMap.set(key, w.userNotes);
                  if (w.status && w.status !== 'new') {
                    userStatusMap.set(key, {
                      status: w.status,
                      interval: w.interval || 0,
                      nextReviewDate: w.nextReviewDate,
                      reviewCount: w.reviewCount || 0,
                      lastReviewedAt: w.lastReviewedAt || null
                    });
                  }
                  // 用户自建词（非内置种子词）保留
                  if (w.id && String(w.id).startsWith('word_custom_')) {
                    customWords.push(w);
                  }
                }
              });
            }
          } catch (e) {
            console.warn('[DataService] 解析旧版本数据失败:', e);
          }
        }

        const now = Date.now();
        const seedData = (typeof INITIAL_VOCABULARY !== 'undefined') ? INITIAL_VOCABULARY.map(w => {
          const key = w.word.toLowerCase();
          const customState = userStatusMap.get(key);
          const userNote = userNotesMap.get(key) || w.userNotes || '';
          return {
            ...w,
            status: customState ? customState.status : (w.status || 'new'),
            interval: customState ? customState.interval : (w.interval || 0),
            nextReviewDate: customState ? customState.nextReviewDate : (w.nextReviewDate || now),
            reviewCount: customState ? customState.reviewCount : (w.reviewCount || 0),
            lastReviewedAt: customState ? customState.lastReviewedAt : (w.lastReviewedAt || null),
            userNotes: userNote
          };
        }) : [];

        // 将用户自定义添加的生词一并合并保留
        if (customWords.length > 0) {
          seedData.push(...customWords);
        }

        localStorage.setItem(STORAGE_KEY, JSON.stringify(seedData));
      } else {
        // 数据迁移检查：补齐必要字段
        try {
          const list = JSON.parse(stored);
          let modified = false;
          const now = Date.now();
          const migrated = list.map(item => {
            let changed = false;
            let interval = item.interval;
            let nextReviewDate = item.nextReviewDate;
            let userNotes = item.userNotes;

            if (typeof interval === 'undefined' || !nextReviewDate) {
              changed = true;
              interval = interval || 0;
              nextReviewDate = nextReviewDate || now;
            }
            if (typeof userNotes === 'undefined') {
              changed = true;
              userNotes = '';
            }
            if (changed) {
              modified = true;
              return {
                ...item,
                userNotes,
                interval,
                nextReviewDate,
                lastReviewedAt: item.lastReviewedAt || null
              };
            }
            return item;
          });
          if (modified) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
          }
        } catch (e) {
          console.warn('[DataService] 数据格式校验异常:', e);
        }
      }
    } catch (err) {
      console.warn('[DataService] 本地存储初始化警告:', err);
    }
  },

  /**
   * 获取全部单词列表
   * 对应 Supabase: const { data, error } = await supabase.from('words').select('*').order('created_at');
   * @returns {Promise<Array>} 单词对象数组
   */
  async getWords() {
    return new Promise((resolve) => {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          resolve(JSON.parse(stored));
        } else {
          const fallback = (typeof INITIAL_VOCABULARY !== 'undefined') ? [...INITIAL_VOCABULARY] : [];
          resolve(fallback);
        }
      } catch (err) {
        console.error('[DataService] getWords 读取异常:', err);
        resolve([]);
      }
    });
  },

  /**
   * 根据唯一 ID 查询单个单词
   * 对应 Supabase: const { data } = await supabase.from('words').select('*').eq('id', id).single();
   * @param {string} id 单词唯一标识
   * @returns {Promise<Object|null>}
   */
  async getWordById(id) {
    const list = await this.getWords();
    const found = list.find(item => item.id === id);
    return found ? { ...found } : null;
  },

  /**
   * 新增单词
   * 对应 Supabase: const { data } = await supabase.from('words').insert([newWord]).select().single();
   * @param {Object} word 单词实体（无 id 时自动生成）
   * @returns {Promise<Object>} 保存成功的单词对象
   */
  async addWord(word) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!word || !word.word) {
          throw new Error('新增单词失败：单词英文内容不能为空');
        }

        const list = await this.getWords();
        
        // 构造规范对象，自动补全默认元数据
        const newWord = {
          id: word.id || `word_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          word: word.word.trim(),
          phonetic: word.phonetic || '',
          partOfSpeech: word.partOfSpeech || 'n.',
          definition: word.definition || '',
          exampleEn: word.exampleEn || '',
          exampleCn: word.exampleCn || '',
          tags: Array.isArray(word.tags) ? word.tags : ['自定义'],
          status: word.status || 'new',
          reviewCount: word.reviewCount || 0,
          userNotes: word.userNotes || '',
          interval: Number(word.interval) || 0,
          nextReviewDate: Number(word.nextReviewDate) || Date.now(),
          lastReviewedAt: word.lastReviewedAt || null,
          createdAt: Date.now()
        };

        list.push(newWord);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
        SupabaseService.syncWord(newWord).catch(() => {});
        resolve(newWord);
      } catch (err) {
        console.error('[DataService] addWord 异常:', err);
        reject(err);
      }
    });
  },

  /**
   * 更新指定单词（状态、复习次数、释义等）
   * 对应 Supabase: const { data } = await supabase.from('words').update(updates).eq('id', id).select().single();
   * @param {string} id 单词唯一标识
   * @param {Object} updates 需要更新的键值对（例如 { status: 'mastered', reviewCount: 2 }）
   * @returns {Promise<Object>} 更新后的单词对象
   */
  async updateWord(id, updates) {
    return new Promise(async (resolve, reject) => {
      try {
        const list = await this.getWords();
        const index = list.findIndex(item => item.id === id);

        if (index === -1) {
          throw new Error(`[DataService] 未找到 ID 为 ${id} 的单词`);
        }

        // 合并更新字段并追加最后修改时间戳
        const updatedItem = {
          ...list[index],
          ...updates,
          lastModifiedAt: Date.now()
        };

        list[index] = updatedItem;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
        SupabaseService.syncWord(updatedItem).catch(() => {});
        resolve(updatedItem);
      } catch (err) {
        console.error('[DataService] updateWord 异常:', err);
        reject(err);
      }
    });
  },

  /**
   * 删除指定单词
   * 对应 Supabase: await supabase.from('words').delete().eq('id', id);
   * @param {string} id 单词唯一标识
   * @returns {Promise<boolean>} 是否删除成功
   */
  async deleteWord(id) {
    return new Promise(async (resolve, reject) => {
      try {
        const list = await this.getWords();
        const filtered = list.filter(item => item.id !== id);

        if (filtered.length === list.length) {
          resolve(false); // 未找到需删除的项
          return;
        }

        localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
        SupabaseService.deleteWord(id).catch(() => {});
        resolve(true);
      } catch (err) {
        console.error('[DataService] deleteWord 异常:', err);
        reject(err);
      }
    });
  },

  /**
   * 导出备份数据包
   * @returns {Promise<Object>}
   */
  async exportBackup() {
    const list = await this.getWords();
    return {
      version: 1,
      appName: '不背英语 Lite',
      exportedAt: new Date().toISOString(),
      totalWords: list.length,
      vocabulary: list
    };
  },

  /**
   * 导入并恢复数据
   * @param {Array} rawItems - 待导入的原始单词列表
   * @param {'overwrite'|'merge'} [strategy='merge'] - 导入策略（'overwrite': 覆盖现有；'merge': 合并去重）
   * @returns {Promise<{ success: boolean, total: number, added: number, updated: number, list: Array }>}
   */
  async importBackup(rawItems, strategy = 'merge') {
    return new Promise(async (resolve, reject) => {
      try {
        if (!Array.isArray(rawItems) || rawItems.length === 0) {
          throw new Error('导入失败：备份数据中未检测到有效词汇列表');
        }

        // 标准化校验与清洗每一个单词项
        const cleanIncoming = rawItems.filter(item => item && typeof item === 'object' && item.word).map(item => ({
          id: item.id || `word_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          word: String(item.word).trim(),
          phonetic: item.phonetic || '',
          partOfSpeech: item.partOfSpeech || 'n.',
          definition: item.definition || '未指定释义',
          exampleEn: item.exampleEn || '',
          exampleCn: item.exampleCn || '',
          tags: Array.isArray(item.tags) ? item.tags : ['自定义'],
          status: ['new', 'learning', 'mastered'].includes(item.status) ? item.status : 'new',
          reviewCount: Number(item.reviewCount) || 0,
          interval: Number(item.interval) || 0,
          nextReviewDate: Number(item.nextReviewDate) || Date.now(),
          lastReviewedAt: item.lastReviewedAt || null,
          userNotes: item.userNotes || '',
          createdAt: item.createdAt || Date.now()
        }));

        if (cleanIncoming.length === 0) {
          throw new Error('导入失败：未找到格式合规的单词对象');
        }

        let finalList = [];
        let addedCount = 0;
        let updatedCount = 0;

        if (strategy === 'overwrite') {
          // 策略 1：完全覆盖现有词库
          finalList = cleanIncoming;
          addedCount = cleanIncoming.length;
        } else {
          // 策略 2：与现有词库智能合并（根据英文单词大小写不敏感去重）
          const currentList = await this.getWords();
          const wordMap = new Map();

          currentList.forEach(w => {
            wordMap.set(w.word.toLowerCase().trim(), { ...w });
          });

          cleanIncoming.forEach(item => {
            const key = item.word.toLowerCase().trim();
            if (wordMap.has(key)) {
              // 相同单词：合并更新释义并保留进度记录
              const existing = wordMap.get(key);
              wordMap.set(key, {
                ...existing,
                ...item,
                // 状态取更优或已学过的值
                reviewCount: Math.max(existing.reviewCount || 0, item.reviewCount || 0),
                status: (item.status === 'mastered' || existing.status === 'mastered') 
                  ? 'mastered' 
                  : (item.status === 'learning' || existing.status === 'learning' ? 'learning' : 'new'),
                interval: Math.max(existing.interval || 0, item.interval || 0),
                nextReviewDate: item.nextReviewDate || existing.nextReviewDate || Date.now(),
                lastReviewedAt: item.lastReviewedAt || existing.lastReviewedAt || null,
                userNotes: item.userNotes || existing.userNotes || '',
                lastModifiedAt: Date.now()
              });
              updatedCount++;
            } else {
              // 新单词：追加
              wordMap.set(key, item);
              addedCount++;
            }
          });

          finalList = Array.from(wordMap.values());
        }

        // 保存至 LocalStorage
        localStorage.setItem(STORAGE_KEY, JSON.stringify(finalList));

        resolve({
          success: true,
          total: finalList.length,
          added: addedCount,
          updated: updatedCount,
          list: finalList
        });
      } catch (err) {
        console.error('[DataService] importBackup 异常:', err);
        reject(err);
      }
    });
  },

  /**
   * 重置/恢复默认词库（便于复习重测）
   * @returns {Promise<Array>}
   */
  async resetVocabulary() {
    const seedData = (typeof INITIAL_VOCABULARY !== 'undefined') ? INITIAL_VOCABULARY.map(w => ({
      ...w,
      interval: 0,
      nextReviewDate: Date.now(),
      lastReviewedAt: null
    })) : [];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seedData));
    return seedData;
  }
};

/**
 * SRSService - 间隔重复算法控制器 (Spaced Repetition System)
 * 复习阶梯：0天 (当天) -> 1天 -> 3天 -> 7天 -> 15天 -> 30天 (稳定记忆)
 */
const SRS_INTERVALS = [1, 3, 7, 15, 30];

const SRSService = {
  /**
   * 点击“已掌握”计算递增复习间隔与下一次到期时间
   * 阶梯规律：0 -> 1天 -> 3天 -> 7天 -> 15天 -> 30天
   * @param {Object} word 
   * @returns {{ interval: number, nextReviewDate: number, status: string, reviewCount: number, lastReviewedAt: number }}
   */
  calculateMastered(word) {
    const currentInterval = Number(word.interval) || 0;
    let nextInterval = 1;

    const matchedIdx = SRS_INTERVALS.indexOf(currentInterval);
    if (matchedIdx !== -1 && matchedIdx < SRS_INTERVALS.length - 1) {
      nextInterval = SRS_INTERVALS[matchedIdx + 1];
    } else if (currentInterval >= 30) {
      // 达到或超过 30 天，进入长期巩固期，间隔翻倍
      nextInterval = Math.round(currentInterval * 2);
    } else {
      // 从未背过(0天)或自定义天数，取首个大于当前值的阶梯
      const higher = SRS_INTERVALS.find(i => i > currentInterval);
      nextInterval = higher || 1;
    }

    const now = Date.now();
    // 计算下次复习时间戳（当前时间 + interval 天）
    const nextReviewDate = now + (nextInterval * 24 * 60 * 60 * 1000);
    // 间隔达到 15 天及以上时归为已掌握
    const status = nextInterval >= 15 ? 'mastered' : 'learning';

    return {
      interval: nextInterval,
      nextReviewDate: nextReviewDate,
      status: status,
      reviewCount: (Number(word.reviewCount) || 0) + 1,
      lastReviewedAt: now
    };
  },

  /**
   * 点击“模糊 / 忘记”重置间隔
   * 规则：将间隔重置为当天（interval = 0），放回当天复习队列再次强化
   * @param {Object} word
   * @returns {{ interval: number, nextReviewDate: number, status: string, reviewCount: number, lastReviewedAt: number }}
   */
  calculateFuzzy(word) {
    const now = Date.now();
    return {
      interval: 0,
      nextReviewDate: now,
      status: 'learning',
      reviewCount: (Number(word.reviewCount) || 0) + 1,
      lastReviewedAt: now
    };
  },

  /**
   * 每日任务生成：优先提取已学且到期的复习单词，未学新词每日限量引入（默认 20 词）
   * 彻底避免数千生词一次性堆积到首日任务队列造成体验灾难
   * @param {Array} words 全量单词列表
   * @param {number} [newLimit=20] 每日新词限额
   * @returns {Array} 今日待复习与学习单词列表
   */
  generateTodayTasks(words, newLimit = 20) {
    if (!Array.isArray(words) || words.length === 0) return [];

    // 计算今天结束的临界时间（23:59:59.999）
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    const threshold = endOfToday.getTime();

    // 1. 已学过且当前已到期的复习词汇 (reviewCount > 0 或处于 learning/mastered 阶段)
    const dueWords = [];
    // 2. 从未背过的新词 (reviewCount === 0 或 status === 'new')
    const newWords = [];

    for (const w of words) {
      const isLearned = (Number(w.reviewCount) > 0) || (w.status === 'learning') || (w.status === 'mastered');
      if (isLearned) {
        if (Number(w.nextReviewDate) <= threshold) {
          dueWords.push(w);
        }
      } else {
        newWords.push(w);
      }
    }

    // 复习词按到期时间升序排列，越早超期的排在越前面
    dueWords.sort((a, b) => (a.nextReviewDate || 0) - (b.nextReviewDate || 0));

    // 每日新词配额裁剪
    const todayNewQuota = newWords.slice(0, newLimit);

    return [...dueWords, ...todayNewQuota];
  },

  /**
   * 人性化格式化下一次复习提示（用于词库列表直观展示）
   * @param {Object} word
   * @returns {{ text: string, isDue: boolean, badgeClass: string }}
   */
  getDueInfo(word) {
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    const todayThreshold = endOfToday.getTime();

    const nextDate = Number(word.nextReviewDate);
    if (!nextDate || nextDate <= todayThreshold) {
      return {
        text: '今日待复习',
        isDue: true,
        badgeClass: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-300/30'
      };
    }

    const diffDays = Math.ceil((nextDate - Date.now()) / (24 * 60 * 60 * 1000));
    if (diffDays <= 1) {
      return {
        text: '明天复习',
        isDue: false,
        badgeClass: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-300/30'
      };
    }

    return {
      text: `${diffDays} 天后复习 (${word.interval}天阶段)`,
      isDue: false,
      badgeClass: 'bg-gold-50 dark:bg-gold-950/40 text-gold-700 dark:text-gold-300 border border-gold-300/30'
    };
  }
};

/* ---------------- 3. StatsService: 学习数据统计与打卡服务 ---------------- */
const STATS_STORAGE_KEY = 'bubei_study_stats_v1';

const StatsService = {
  /**
   * 格式化 Date 为 YYYY-MM-DD
   */
  formatDate(date = new Date()) {
    const d = new Date(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  /**
   * 初始化统计数据（干净初始状态，无虚假历史打卡与连击数据）
   */
  init() {
    try {
      const stored = localStorage.getItem(STATS_STORAGE_KEY);
      if (!stored) {
        const todayStr = this.formatDate();
        const cleanStats = {
          dailyCounts: { [todayStr]: 0 },
          checkInDates: [],
          bestStreak: 0,
          lastActiveDate: todayStr
        };
        localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(cleanStats));
      }
    } catch (e) {
      console.warn('[StatsService] init 异常:', e);
    }
  },

  /**
   * 读取统计数据
   */
  getStats() {
    try {
      this.init();
      const stored = localStorage.getItem(STATS_STORAGE_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        if (!data.dailyCounts) data.dailyCounts = {};
        if (!Array.isArray(data.checkInDates)) data.checkInDates = [];
        if (typeof data.bestStreak !== 'number') data.bestStreak = 0;
        return data;
      }
    } catch (e) {
      console.warn('[StatsService] getStats 异常:', e);
    }
    return { dailyCounts: {}, checkInDates: [], bestStreak: 0 };
  },

  /**
   * 保存统计数据
   */
  saveStats(stats) {
    try {
      localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(stats));
      SupabaseService.syncStats(stats).catch(() => {});
    } catch (e) {
      console.warn('[StatsService] saveStats 异常:', e);
    }
  },

  /**
   * 计算连续打卡天数（Streak）
   * 规则：
   * - 检查今天是否已打卡 (today in checkInDates)
   *   - 如果今天已打卡：从今天开始往前倒推连续打卡天数
   *   - 如果今天未打卡，但昨天已打卡：Streak 处于保留待续状态，从昨天开始往前倒推连续打卡天数
   *   - 如果今天和昨天都未打卡：Streak 中断归零 (0)
   */
  calculateStreak(checkInDates = []) {
    if (!Array.isArray(checkInDates) || checkInDates.length === 0) return 0;
    const dateSet = new Set(checkInDates);

    const todayStr = this.formatDate();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = this.formatDate(yesterday);

    let streak = 0;
    let checkDate = new Date();

    if (dateSet.has(todayStr)) {
      // 今天已打卡，从今天开始往前回溯
      while (true) {
        const dStr = this.formatDate(checkDate);
        if (dateSet.has(dStr)) {
          streak++;
          checkDate.setDate(checkDate.getDate() - 1);
        } else {
          break;
        }
      }
    } else if (dateSet.has(yesterdayStr)) {
      // 今天尚未打卡，但昨天打卡了，连续天数暂时保持昨天的连续值
      checkDate = yesterday;
      while (true) {
        const dStr = this.formatDate(checkDate);
        if (dateSet.has(dStr)) {
          streak++;
          checkDate.setDate(checkDate.getDate() - 1);
        } else {
          break;
        }
      }
    } else {
      streak = 0;
    }

    return streak;
  },

  /**
   * 记录一次单词复习
   * @param {number} count 增加的复习词数，默认为 1
   * @returns {{ todayCount: number, streak: number, bestStreak: number, justCheckedIn: boolean, isCheckedInToday: boolean }}
   */
  recordReview(count = 1) {
    const stats = this.getStats();
    const todayStr = this.formatDate();

    const previousCount = stats.dailyCounts[todayStr] || 0;
    const newCount = previousCount + count;
    stats.dailyCounts[todayStr] = newCount;

    let justCheckedIn = false;
    const hasCheckedInBefore = stats.checkInDates.includes(todayStr);

    // 核心打卡规则：当今天复习词数达到 5 词及以上且尚未记录打卡时，自动记录今天打卡
    if (newCount >= 5 && !hasCheckedInBefore) {
      stats.checkInDates.push(todayStr);
      justCheckedIn = true;
    }

    const currentStreak = this.calculateStreak(stats.checkInDates);
    if (currentStreak > stats.bestStreak) {
      stats.bestStreak = currentStreak;
    }

    this.saveStats(stats);

    return {
      todayCount: newCount,
      streak: currentStreak,
      bestStreak: stats.bestStreak,
      justCheckedIn,
      isCheckedInToday: stats.checkInDates.includes(todayStr)
    };
  },

  /**
   * 获取最近 7 天的复习统计与图表数据（从 6 天前至今天）
   */
  getPast7DaysData() {
    const stats = this.getStats();
    const todayStr = this.formatDate();
    const result = [];
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = this.formatDate(d);
      const count = stats.dailyCounts[dateStr] || 0;
      const isToday = (i === 0);
      const dayOfWeek = weekdays[d.getDay()];
      const shortDate = `${d.getMonth() + 1}/${d.getDate()}`;
      const isCheckedIn = stats.checkInDates.includes(dateStr);

      result.push({
        dateStr,
        count,
        isToday,
        dayLabel: isToday ? '今天' : (i === 1 ? '昨天' : dayOfWeek),
        shortDate,
        isCheckedIn
      });
    }

    const total7Days = result.reduce((sum, item) => sum + item.count, 0);
    const maxCount = Math.max(5, ...result.map(r => r.count));

    return {
      days: result,
      total7Days,
      maxCount,
      streak: this.calculateStreak(stats.checkInDates),
      bestStreak: stats.bestStreak,
      todayCount: stats.dailyCounts[todayStr] || 0,
      isCheckedInToday: stats.checkInDates.includes(todayStr)
    };
  }
};

/* ---------------- 4. AchievementService: 徽章成就与里程碑服务 ---------------- */
const ACHIEVEMENTS_STORAGE_KEY = 'bubei_achievements_v1';

const PRESET_ACHIEVEMENTS = [
  {
    id: 'first_word',
    name: '初学启程',
    icon: '🌱',
    desc: '迈出学术英语第一步，掌握首个核心词汇',
    calcProgress: (ctx) => {
      const current = ctx.masteredCount || 0;
      return {
        current,
        target: 1,
        text: current >= 1 ? '已达成' : `${current}/1 词`,
        percent: Math.min(100, Math.round((current / 1) * 100))
      };
    },
    checkUnlock: (ctx) => (ctx.masteredCount || 0) >= 1
  },
  {
    id: 'vocab_100',
    name: '单词斩百',
    icon: '⚔️',
    desc: '突破百词大关，建立稳定学术语感',
    calcProgress: (ctx) => {
      const current = ctx.masteredCount || 0;
      return {
        current,
        target: 100,
        text: current >= 100 ? '已达成' : `${current}/100 词`,
        percent: Math.min(100, Math.round((current / 100) * 100))
      };
    },
    checkUnlock: (ctx) => (ctx.masteredCount || 0) >= 100
  },
  {
    id: 'vocab_500',
    name: '学术进阶',
    icon: '📚',
    desc: '累计掌握 500 个学术核心词，轻松应对阅读障碍',
    calcProgress: (ctx) => {
      const current = ctx.masteredCount || 0;
      return {
        current,
        target: 500,
        text: current >= 500 ? '已达成' : `${current}/500 词`,
        percent: Math.min(100, Math.round((current / 500) * 100))
      };
    },
    checkUnlock: (ctx) => (ctx.masteredCount || 0) >= 500
  },
  {
    id: 'vocab_1000',
    name: '词汇破千',
    icon: '🛡️',
    desc: '斩获千词里程碑，从容精读原版学术文献',
    calcProgress: (ctx) => {
      const current = ctx.masteredCount || 0;
      return {
        current,
        target: 1000,
        text: current >= 1000 ? '已达成' : `${current}/1000 词`,
        percent: Math.min(100, Math.round((current / 1000) * 100))
      };
    },
    checkUnlock: (ctx) => (ctx.masteredCount || 0) >= 1000
  },
  {
    id: 'streak_3',
    name: '自律星火',
    icon: '🔥',
    desc: '持之以恒，连续完成 3 天打卡',
    calcProgress: (ctx) => {
      const current = ctx.streak || 0;
      return {
        current,
        target: 3,
        text: current >= 3 ? '已达成' : `${current}/3 天`,
        percent: Math.min(100, Math.round((current / 3) * 100))
      };
    },
    checkUnlock: (ctx) => (ctx.streak || 0) >= 3
  },
  {
    id: 'streak_7',
    name: '自律达人',
    icon: '👑',
    desc: '百炼成钢，连续完成 7 天打卡',
    calcProgress: (ctx) => {
      const current = ctx.streak || 0;
      return {
        current,
        target: 7,
        text: current >= 7 ? '已达成' : `${current}/7 天`,
        percent: Math.min(100, Math.round((current / 7) * 100))
      };
    },
    checkUnlock: (ctx) => (ctx.streak || 0) >= 7
  },
  {
    id: 'streak_30',
    name: '月度标兵',
    icon: '🌟',
    desc: '自律沉淀为习惯，连续坚持打卡达到 30 天',
    calcProgress: (ctx) => {
      const current = ctx.streak || 0;
      return {
        current,
        target: 30,
        text: current >= 30 ? '已达成' : `${current}/30 天`,
        percent: Math.min(100, Math.round((current / 30) * 100))
      };
    },
    checkUnlock: (ctx) => (ctx.streak || 0) >= 30
  },
  {
    id: 'perfect_test',
    name: '全能学者',
    icon: '⚡',
    desc: '在拼写测试或四选题自测中斩获 100% 满分',
    calcProgress: (ctx) => {
      const isDone = !!ctx.hasPerfectScore;
      return {
        current: isDone ? 1 : 0,
        target: 1,
        text: isDone ? '已达成' : '待自测满分',
        percent: isDone ? 100 : 0
      };
    },
    checkUnlock: (ctx) => !!ctx.hasPerfectScore
  }
];

const AchievementService = {
  init() {
    try {
      const stored = localStorage.getItem(ACHIEVEMENTS_STORAGE_KEY);
      if (!stored) {
        const initial = {
          unlocked: {},
          hasPerfectScore: false
        };
        localStorage.setItem(ACHIEVEMENTS_STORAGE_KEY, JSON.stringify(initial));
      }
    } catch (e) {
      console.warn('[AchievementService] init 异常:', e);
    }
  },

  getData() {
    try {
      this.init();
      const stored = localStorage.getItem(ACHIEVEMENTS_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (!parsed.unlocked) parsed.unlocked = {};
        return parsed;
      }
    } catch (e) {
      console.warn('[AchievementService] getData 异常:', e);
    }
    return { unlocked: {}, hasPerfectScore: false };
  },

  saveData(data) {
    try {
      localStorage.setItem(ACHIEVEMENTS_STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('[AchievementService] saveData 异常:', e);
    }
  },

  /**
   * 标记已达成满分测试 (拼写或选择题)
   */
  recordPerfectScore() {
    const data = this.getData();
    data.hasPerfectScore = true;
    this.saveData(data);
  },

  /**
   * 获取所有 6 个预设成就及其在当前上下文下的达成状态与进度
   */
  getAchievements(context = {}) {
    const data = this.getData();
    const mergedContext = {
      ...context,
      hasPerfectScore: data.hasPerfectScore || !!context.hasPerfectScore
    };

    return PRESET_ACHIEVEMENTS.map(ach => {
      const isUnlocked = !!data.unlocked[ach.id];
      const unlockedAt = data.unlocked[ach.id] || null;
      const progress = ach.calcProgress(mergedContext);

      return {
        id: ach.id,
        name: ach.name,
        icon: ach.icon,
        desc: ach.desc,
        isUnlocked,
        unlockedAt,
        progress
      };
    });
  },

  /**
   * 核心检测：判断是否有新满足条件的成就，自动解锁并返回最新解锁列表
   * @param {Object} context 上下文数据 { totalWords, masteredCount, streak, hasPerfectScore }
   * @returns {Array} 新解锁的成就对象列表 (若无新解锁则为空数组)
   */
  checkMilestones(context = {}) {
    const data = this.getData();
    if (context.hasPerfectScore) {
      data.hasPerfectScore = true;
    }
    const mergedContext = {
      ...context,
      hasPerfectScore: data.hasPerfectScore || !!context.hasPerfectScore
    };

    const newlyUnlocked = [];

    PRESET_ACHIEVEMENTS.forEach(ach => {
      // 若尚未解锁，且满足检测条件
      if (!data.unlocked[ach.id] && ach.checkUnlock(mergedContext)) {
        const now = Date.now();
        data.unlocked[ach.id] = now;
        newlyUnlocked.push({
          id: ach.id,
          name: ach.name,
          icon: ach.icon,
          desc: ach.desc,
          unlockedAt: now
        });
      }
    });

    if (newlyUnlocked.length > 0 || context.hasPerfectScore) {
      this.saveData(data);
    }

    return newlyUnlocked;
  }
};

// 挂载至全局与模块系统
if (typeof window !== 'undefined') {
  window.DataService = DataService;
  window.SRSService = SRSService;
  window.StatsService = StatsService;
  window.AchievementService = AchievementService;
  window.SupabaseService = SupabaseService;
  window.SUPABASE_CONFIG = SUPABASE_CONFIG;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DataService, SRSService, StatsService, AchievementService, SupabaseService, SUPABASE_CONFIG };
}
