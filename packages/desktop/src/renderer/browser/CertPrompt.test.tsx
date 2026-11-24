/**
 * Слой выбора клиентского сертификата: список, галочка «запомнить», «Not now» и Esc, строка о странице, ошибка отправки.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BrowserCertRequest, ClientCertInfo } from '../../shared/client-cert.js';
import { S } from '../../shared/strings.js';
import { CertPrompt } from './CertPrompt.js';

afterEach(cleanup);

function cert(n: number): ClientCertInfo {
  return { fingerprint: `sha256/fp-${n}`, subjectName: `Subject ${n}`, issuerName: `Issuer ${n}`, serialNumber: `0${n}`, validExpiry: 1_800_000_000 + n };
}

function request(count: number, extra: Partial<BrowserCertRequest> = {}): BrowserCertRequest {
  return {
    requestId: 'c1',
    webContentsId: 7,
    host: 'auth.example.com:6443',
    pageHost: null,
    certificates: Array.from({ length: count }, (_, i) => cert(i + 1)),
    ...extra,
  };
}

describe('CertPrompt', () => {
  it('один сертификат выбран заранее и в фокусе; Use certificate отдаёт отпечаток без «запомнить»', () => {
    const onSubmit = vi.fn();
    render(<CertPrompt request={request(1)} onSubmit={onSubmit} />);
    expect(screen.getByTestId('browser-cert')).toBeTruthy();
    expect(screen.getByTestId('browser-cert-host').textContent).toBe('auth.example.com:6443 asks for a certificate that identifies you.');
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(1);
    expect(radios[0]?.checked).toBe(true);
    expect(document.activeElement).toBe(radios[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Use certificate' }));
    expect(onSubmit).toHaveBeenCalledWith({ fingerprint: 'sha256/fp-1', remember: false });
  });

  it('три сертификата: первый выбран; третий и галочка отдают его отпечаток с remember', () => {
    const onSubmit = vi.fn();
    render(<CertPrompt request={request(3)} onSubmit={onSubmit} />);
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((radio) => radio.checked)).toEqual([true, false, false]);
    fireEvent.click(radios[2] as HTMLInputElement);
    expect((screen.getAllByRole('radio') as HTMLInputElement[]).map((radio) => radio.checked)).toEqual([false, false, true]);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Use certificate' }));
    expect(onSubmit).toHaveBeenCalledWith({ fingerprint: 'sha256/fp-3', remember: true });
  });

  it('у сертификата видны субъект, издатель, срок и серийный номер; есть строка про доступ macOS к ключу', () => {
    render(<CertPrompt request={request(1)} onSubmit={vi.fn()} />);
    expect(screen.getByText('Subject 1')).toBeTruthy();
    expect(screen.getByText('Issued by Issuer 1')).toBeTruthy();
    expect(screen.getByText(S.browser.cert.expires(new Date(1_800_000_001 * 1000).toLocaleDateString()))).toBeTruthy();
    expect(screen.getByText('Serial 01')).toBeTruthy();
    expect(screen.getByText(S.browser.cert.keyAccess)).toBeTruthy();
    expect(screen.getByText(S.browser.cert.remember)).toBeTruthy();
  });

  it('pageHost: строка «Requested by the page …» есть, а при null её нет', () => {
    const { rerender } = render(<CertPrompt request={request(1, { pageHost: 'example.com' })} onSubmit={vi.fn()} />);
    expect(screen.getByText('Requested by the page example.com.')).toBeTruthy();
    rerender(<CertPrompt request={request(1, { pageHost: null })} onSubmit={vi.fn()} />);
    expect(screen.queryByText(/Requested by the page/)).toBeNull();
  });

  it('Escape и Not now — «не сейчас» (null); кнопки Cancel и строки-предупреждения нет', () => {
    const onSubmit = vi.fn();
    render(<CertPrompt request={request(2)} onSubmit={onSubmit} />);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.queryByText(/will not ask again/)).toBeNull();
    fireEvent.keyDown(screen.getAllByRole('radio')[0] as HTMLElement, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onSubmit).toHaveBeenNthCalledWith(1, null);
    expect(onSubmit).toHaveBeenNthCalledWith(2, null);
  });

  it('failed: role="alert" со строкой об ошибке отправки; без failed алерта нет', () => {
    const { rerender } = render(<CertPrompt request={request(1)} onSubmit={vi.fn()} />);
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(<CertPrompt request={request(1)} failed onSubmit={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toBe(S.browser.cert.sendFailed);
  });

  it('новый requestId сбрасывает галочку и выбор на первый сертификат', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<CertPrompt request={request(3)} onSubmit={onSubmit} />);
    fireEvent.click(screen.getAllByRole('radio')[1] as HTMLElement);
    fireEvent.click(screen.getByRole('checkbox'));
    rerender(<CertPrompt request={request(3, { requestId: 'c2' })} onSubmit={onSubmit} />);
    expect((screen.getAllByRole('radio') as HTMLInputElement[]).map((radio) => radio.checked)).toEqual([true, false, false]);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Use certificate' }));
    expect(onSubmit).toHaveBeenCalledWith({ fingerprint: 'sha256/fp-1', remember: false });
  });
});
