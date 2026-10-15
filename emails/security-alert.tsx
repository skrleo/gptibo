import { emailBrand } from './brand.ts'
import * as React from 'react'
import { Body, Button, Column, Container, Head, Heading, Html, Img, Preview, Row, Section, Text } from 'react-email'
import { securityAlertTokens } from './security-alert-copy.ts'

export default function SecurityAlertEmail() {
  return <Html lang="zh-CN">
    <Head><meta name="color-scheme" content="light dark" /><style>{`
      @media only screen and (max-width:600px) { .alert-content { padding:28px 24px !important; } }
      @media (prefers-color-scheme:dark) {
        .alert-body, .alert-body > table > tbody > tr > td { background:#101011 !important; }
        .alert-card { background:#1d1d1f !important; border-color:#353538 !important; }
        .alert-ink { color:#f5f5f7 !important; }
        .alert-muted { color:#b5b5bc !important; }
        .alert-panel { background:#29292c !important; }
      }
    `}</style></Head>
    <Preview>检测到异常请求，请登录管理后台查看安全审计。</Preview>
    <Body className="alert-body" style={{ margin:0, padding:'48px 16px', backgroundColor:'#f5f5f7', fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif' }}>
      <Container style={{ maxWidth:'520px', margin:'0 auto' }}>
        <Section style={{ padding:'0 8px 24px' }}><Row><Column style={{ width:'42px' }}><Img src={emailBrand.logo} width="32" height="32" alt="" /></Column><Column><Text className="alert-ink" style={{ wordBreak: 'break-all', color:'#1d1d1f', fontSize:'21px', margin:0, fontWeight:600 }}>{emailBrand.name}</Text></Column></Row></Section>
        <Section className="alert-card" style={{ backgroundColor:'#fff', border:'1px solid #e5e5ea', borderRadius:'20px' }}>
          <Section className="alert-content" style={{ padding:'36px' }}>
            <Heading className="alert-ink" as="h1" style={{ color:'#1d1d1f', fontSize:'28px', lineHeight:'1.3', margin:'0 0 20px' }}>安全审计窗口告警</Heading>
            <Text className="alert-muted" style={{ color:'#6e6e73', fontSize:'14px', lineHeight:'24px' }}>您好，系统在以下 15 分钟窗口内记录到异常请求。连续异常会触发 15 分钟限制，完整记录请在管理后台的「安全审计」中查看。</Text>
            <Section className="alert-panel" style={{ backgroundColor:'#f5f5f7', borderRadius:'12px', padding:'20px 24px', marginTop:'24px' }}>
              <Text className="alert-ink" style={{ color:'#1d1d1f', fontSize:'14px', lineHeight:'22px', margin:'0 0 10px', fontWeight:600 }}>窗口：{securityAlertTokens.window}</Text>
              <Text className="alert-muted" style={{ color:'#6e6e73', fontSize:'13px', lineHeight:'22px', margin:'0 0 10px' }}>汇总：{securityAlertTokens.totals}</Text>
              <Text className="alert-muted" style={{ color:'#6e6e73', fontSize:'13px', lineHeight:'22px', margin:0, whiteSpace:'pre-line', wordBreak:'break-all' }}>主要接口：{securityAlertTokens.routes}</Text>
            </Section>
            <Button href={emailBrand.admin} style={{ backgroundColor:'#0071e3', color:'#fff', borderRadius:'10px', padding:'15px 24px', fontSize:'15px', fontWeight:600, textDecoration:'none', marginTop:'12px' }}>打开管理后台 →</Button>
            <Text className="alert-muted" style={{ color:'#86868b', fontSize:'12px', lineHeight:'21px', margin:'22px 0 0' }}>审计记录只包含来源指纹与会话指纹，不含验证码、会话原文或请求内容。</Text>
          </Section>
        </Section>
        <Text className="alert-muted" style={{ color:'#86868b', fontSize:'11px', lineHeight:'19px', padding:'12px 8px', wordBreak:'break-all' }}>此邮件由系统自动发送，请勿直接回复。<br />{emailBrand.name} · 独立服务商</Text>
      </Container>
    </Body>
  </Html>
}
