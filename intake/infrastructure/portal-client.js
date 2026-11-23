/**
 * 旧门户浏览器界面客户端。
 * 门户只有本地浏览器界面（HTML 表单 + 异步流水页），本客户端用 fetch 复现浏览器的
 * GET 表单 / POST 提交 / 轮询流水操作；所有 HTTP 往来留在 calls 里可复核。
 * 关键语义：
 *  - POST 后“页面连接已关闭”不等于失败：受理可能仍成立，必须回流水页确认；
 *  - 422 表单拒绝表示该页未开放单独调取，不产生受理、不扣份数；
 *  - 正式收据只能在异步取档页（流水页出现“文件可取”后）请求。
 */
import { FolioNotSeparableError, PortalContractError } from '../domain/errors.js';
import {
  parseArchiveHome,
  parsePackageManifest,
  parsePullResponse,
  parseRequestsPage,
  parseScanPage,
  parseSearchPage,
} from './html-parser.js';

export class BrowserPortalClient {
  constructor({ baseUrl, office, fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.office = office; // old | new（同名任务号/受理号按机关区分）
    this.fetch = fetchImpl;
    this.calls = [];
  }

  async _get(path) {
    const response = await this.fetch(this.baseUrl + path);
    const html = await response.text();
    this.calls.push({ method: 'GET', path, status: response.status });
    return { status: response.status, html };
  }

  async _post(path, form) {
    const body = new URLSearchParams(form).toString();
    const response = await this.fetch(this.baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const html = await response.text();
    this.calls.push({ method: 'POST', path, status: response.status, body });
    return { status: response.status, html };
  }

  /** 打开档案调阅入口，确认会话与机关选项。 */
  async openArchive() {
    const { html } = await this._get('/archive');
    return parseArchiveHome(html);
  }

  /**
   * 发起/刷新查询。查询任务可以分片出结果：调用方按门户阶段多次轮询，
   * 每次返回当前分片（STREAMING / SEALED）。
   */
  async search(subject) {
    const { html } = await this._get(
      `/archive/search?office=${encodeURIComponent(this.office)}&subject=${encodeURIComponent(subject)}`,
    );
    return parseSearchPage(html);
  }

  /**
   * 提交取档请求（一份包可合并多个档号，逗号分隔）。
   * 返回：
   *  { outcome:'ACCEPTED', acceptanceNo }         门户直接受理；
   *  { outcome:'CONNECTION_CLOSED' }              窗口关闭，去流水页等结论；
   *  422 -> 抛 FolioNotSeparableError（未受理、不扣份）。
   */
  async submitPull({ subject, folios }) {
    const folio = folios.join(',');
    const { status, html } = await this._post(`/archive/pull/${this.office}`, { subject, folio });
    if (status === 422) {
      throw new FolioNotSeparableError('门户表单拒绝：该档页未开放单独调取或不属于本企业', {
        office: this.office, subject, folios,
      });
    }
    return parsePullResponse(html);
  }

  /** 异步流水页：索引/取档结论都在这里确认，受理号按机关区分。 */
  async fetchRequestStream() {
    const { html } = await this._get('/archive/requests');
    return parseRequestsPage(html);
  }

  /** 在流水页定位本机关某档页的最新受理结论。 */
  async locateAcceptance(folio) {
    const stream = await this.fetchRequestStream();
    const match = stream.items.find(item => item.office === this.office && item.folio === folio);
    if (!match) return { known: false, stream };
    return { known: true, ...match, stream };
  }

  /** 文件可取后请求扫描页（正式收据在异步取档流程中挂接）。 */
  async fetchScan(scanPath) {
    const { html } = await this._get(scanPath);
    return parseScanPage(html);
  }

  /** 取扫描包清单（逐页链接，保留物理顺序）。 */
  async fetchPackageManifest(scanPath) {
    const { html } = await this._get(scanPath);
    return parsePackageManifest(html);
  }

  /** 切换演练阶段（仅本地演练来源支持）。 */
  async setScenario(stage) {
    const response = await this.fetch(this.baseUrl + '/scenario/' + stage, { method: 'POST' });
    if (response.status !== 204) {
      throw new PortalContractError(`演练阶段切换失败：${stage}`, { status: response.status });
    }
    this.calls.push({ method: 'POST', path: `/scenario/${stage}`, status: 204 });
  }
}
