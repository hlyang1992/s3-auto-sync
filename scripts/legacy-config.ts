// Development-only credential reader. Not included in the installed plugin.
import { validateConfig } from '../src/model.ts';
import type { Config } from '../src/model.ts';
export function fromRemotelySave(data: unknown): Config {
  const wrapped = data as {readme?: unknown; d?: unknown};
  if (wrapped && typeof wrapped.d === 'string' && 'readme' in wrapped) {
    try {
      const encoded = [...wrapped.d].reverse().join('').replace(/-/g,'+').replace(/_/g,'/');
      data = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded),c => c.charCodeAt(0))));
    } catch { throw new Error('无法解析 Remotely Save 配置。'); }
  }
  const d = data as { serviceType?: string; password?: string; s3?: Record<string, unknown> };
  if (d?.serviceType !== 's3' || !d.s3) throw new Error('Remotely Save 未配置 S3。');
  if (d.password) throw new Error('原同步启用了加密，不能直接导入其远端数据。');
  const s = d.s3;
  if (s.reverseProxyNoSignUrl) throw new Error('暂不支持原插件的免签名反向代理。');
  return validateConfig({endpoint:String(s.s3Endpoint || ''),bucket:String(s.s3BucketName || ''),accessKeyId:String(s.s3AccessKeyID || ''),secretAccessKey:String(s.s3SecretAccessKey || ''),region:String(s.s3Region || ''),prefix:String(s.remotePrefix || ''),pathStyle:!!s.forcePathStyle});
}
