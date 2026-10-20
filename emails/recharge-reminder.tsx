import { emailBrand } from './brand.ts'
import * as React from 'react'
import { Body, Button, Column, Container, Head, Heading, Html, Img, Preview, Row, Section, Text } from 'react-email'
import { reminderTokens } from './reminder-copy.ts'

export default function RechargeReminderEmail() {
  return <Html lang="zh-CN">
    <Head><meta name="color-scheme" content="light dark" /><style>{`
      @media only screen and (max-width:600px) { .reminder-content { padding:28px 24px !important; } }
      @media (prefers-color-scheme:dark) {
        .reminder-body, .reminder-body > table > tbody > tr > td { background:#101011 !important; }
        .reminder-card { background:#1d1d1f !important; border-color:#353538 !important; }
        .reminder-ink { color:#f5f5f7 !important; }
        .reminder-muted { color:#b5b5bc !important; }
        .reminder-panel { background:#29292c !important; }
      }
    `}</style></Head>
    <Preview>检测到您付款后已超过 15 分钟，尚未提交 Session 完成兑换充值。如需帮助，请联系客服。 / Your payment was received 15+ minutes ago but the Session hasn’t been submitted yet.</Preview>
    <Body className="reminder-body" style={{ margin:0, padding:'48px 16px', backgroundColor:'#f5f5f7', fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif' }}>
      <Container style={{ maxWidth:'520px', margin:'0 auto' }}>
        <Section style={{ padding:'0 8px 24px' }}><Row><Column style={{ width:'42px' }}><Img src={emailBrand.logo} width="32" height="32" alt="" /></Column><Column><Text className="reminder-ink" style={{ wordBreak: 'break-all', color:'#1d1d1f', fontSize:'21px', margin:0, fontWeight:600 }}>{emailBrand.name}</Text></Column></Row></Section>
        <Section className="reminder-card" style={{ backgroundColor:'#fff', border:'1px solid #e5e5ea', borderRadius:'20px' }}>
          <Section className="reminder-content" style={{ padding:'36px' }}>
            <Heading className="reminder-ink" as="h1" style={{ color:'#1d1d1f', fontSize:'28px', lineHeight:'1.3', margin:'0 0 8px' }}>您已付款，请继续完成充值 / You’ve paid — one step left</Heading>
            <Text className="reminder-muted" style={{ color:'#6e6e73', fontSize:'14px', lineHeight:'24px' }}>您好，我们检测到您付款后已超过 15 分钟，尚未填写 Session 并提交兑换充值。请打开订单页面，按照指引提交 Session，继续完成充值，无需再次付款。<br />We received your payment 15+ minutes ago but haven’t seen the Session submitted yet. Open your order page and follow the guide to submit the Session — no need to pay again.</Text>
            <Text className="reminder-muted" style={{ color:'#6e6e73', fontSize:'13px', lineHeight:'22px', wordBreak:'break-all' }}>商品 / Plan：{reminderTokens.planName}<br />订单号 / Order：{reminderTokens.orderId}</Text>
            <Button href={emailBrand.orders} style={{ backgroundColor:'#0071e3', color:'#fff', borderRadius:'10px', padding:'15px 24px', fontSize:'15px', fontWeight:600, textDecoration:'none', marginTop:'12px' }}>查看订单，继续充值 / View order &amp; continue →</Button>
            <Text className="reminder-muted" style={{ color:'#6e6e73', fontSize:'12px', lineHeight:'21px' }}>找不到订单？请在「我的订单」中使用收件邮箱获取验证码，即可找回订单。<br />Can’t find the order? Request a code for this inbox on My orders to recover it.</Text>
            <Section className="reminder-panel" style={{ backgroundColor:'#f5f5f7', borderRadius:'12px', padding:'20px 24px', marginTop:'24px' }}>
              <Text className="reminder-ink" style={{ color:'#1d1d1f', fontSize:'14px', lineHeight:'22px', margin:'0 0 10px', fontWeight:600 }}>如需帮助，请联系客服 / Need help? Contact support</Text>
              <Text className="reminder-muted" style={{ color:'#6e6e73', fontSize:'13px', lineHeight:'24px', margin:0, whiteSpace:'pre-line', wordBreak:'break-all' }}>{reminderTokens.contacts}</Text>
            </Section>
            <Text className="reminder-muted" style={{ color:'#86868b', fontSize:'12px', lineHeight:'21px', margin:'22px 0 0' }}>如您已提交充值，请忽略此提醒。请仅在订单页面提交 Session，勿通过邮件或聊天发送登录凭据。<br />If you already submitted, ignore this reminder. Submit the Session only on the order page — never send credentials by email or chat.</Text>
          </Section>
        </Section>
        <Text className="reminder-muted" style={{ color:'#86868b', fontSize:'11px', lineHeight:'19px', padding:'12px 8px', wordBreak:'break-all' }}>此邮件由系统自动发送，请勿直接回复。 / Automated email — please do not reply.<br />{emailBrand.name} · 独立服务商 / Independent reseller</Text>
      </Container>
    </Body>
  </Html>
}
