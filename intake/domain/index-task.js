/**
 * 索引（查询）任务与分片。
 * 旧门户只给浏览器界面：一个查询任务会分多次出结果（分片），状态为
 * STREAMING（检索仍在出页）或 SEALED（索引已封）。
 * 索引结果只有档号与册页引用——命中索引绝不等于取件成功。
 */
export const INDEX_STATUS = Object.freeze({
  STREAMING: 'STREAMING', // 检索仍在出页
  SEALED: 'SEALED',       // 索引已封
});

export class IndexRow {
  constructor({ archiveNo, subject, sheetRange, source, office, taskNo }) {
    this.archiveNo = archiveNo;   // 档号，如 OD-5
    this.subject = subject;       // 归属企业短码；集团同事项号下要按归属过滤
    this.sheetRange = sheetRange; // 册页引用，如 FR-4/1–3
    this.source = source;         // 来源说明：原册 / 同名事项 / 承接出处
    this.office = office;
    this.taskNo = taskNo;
  }

  /** 同一档号被多家企业共用（相同事项号）时的归属判断。 */
  belongsTo(subject) {
    return this.subject === subject;
  }
}

export class IndexTask {
  constructor({ taskNo, office, subject, indexSerial }) {
    this.taskNo = taskNo;         // 门户查询任务号（同名任务号按机关区分）
    this.office = office;
    this.subject = subject;
    this.indexSerial = indexSerial; // 索引请求的可复核流水（与取档流水分开）
    this.shards = [];
    this.status = INDEX_STATUS.STREAMING;
    this.sealedAt = null;
  }

  /** 接收一个分片；门户宣告索引已封时任务收口。 */
  acceptShard({ rows, status, at }) {
    this.shards.push({
      at,
      status,
      rows: rows.map(row => new IndexRow({ ...row, office: this.office, taskNo: this.taskNo })),
    });
    if (status === INDEX_STATUS.SEALED) {
      this.status = INDEX_STATUS.SEALED;
      this.sealedAt = at;
    }
  }

  get isSealed() {
    return this.status === INDEX_STATUS.SEALED;
  }

  /** 跨分片汇总；同一档号+册页+归属去重，保留来源。 */
  rows() {
    const seen = new Set();
    const result = [];
    for (const shard of this.shards) {
      for (const row of shard.rows) {
        const key = [this.office, row.archiveNo, row.subject, row.sheetRange].join('|');
        if (!seen.has(key)) {
          seen.add(key);
          result.push(row);
        }
      }
    }
    return result;
  }

  /** 只返回本企业归属的行；集团代办检索里别家企业的同事项号行不得混入。 */
  rowsFor(subject) {
    return this.rows().filter(row => row.belongsTo(subject));
  }

  /** 索引里是否出现某档页（仅作线索，不能据此认定可取件）。 */
  mentionsFolio(folio) {
    const [archiveNo] = folio.split('/');
    return this.rowsFor(this.subject).some(row => row.archiveNo === archiveNo);
  }
}
