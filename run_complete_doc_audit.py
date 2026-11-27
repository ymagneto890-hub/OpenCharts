import sys
sys.path.append('c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch')
import runnable_doc_script as rds
import pandas as pd
import json

def full_audit(csv_4h, csv_1d, symbol):
    df_4h = rds.audit_ohlcv_continuity(pd.read_csv(csv_4h), expected_freq_hours=4)
    df_1d = rds.audit_ohlcv_continuity(pd.read_csv(csv_1d), expected_freq_hours=24)
    base_params = rds.StrategyParams(risk_per_trade=0.015)
    merged = rds.prepare_multitimeframe_features(df_4h, df_1d, base_params)
    
    cost_spot = rds.CostConfig('Spot', 'spot', 0.0010, 0.0005, 0.0010, 0.0, allow_shorts=False)
    cost_perp = rds.CostConfig('Perp', 'perp', 0.0005, 0.0005, 0.0010, 0.00015, allow_shorts=True)
    
    results = []
    for strat in ['C5_COMBINED', 'C6_BASELINE', 'C4_PULLBACK']:
        for cost in [cost_spot, cost_perp]:
            eq, tr = rds.run_backtest(merged, strat, base_params, cost, initial_capital=1000.0)
            m = rds.compute_mandatory_metrics(eq, tr)
            results.append({
                'symbol': symbol,
                'strat': strat,
                'market': cost.market_type,
                'initial': 1000.0,
                'final': round(float(eq['equity'].iloc[-1]), 2),
                'ret_pct': m['Rentabilidad_Neta_Acumulada_Pct'],
                'cagr_pct': m['CAGR_Anualizado_Pct'],
                'max_dd_pct': m['Maximo_Drawdown_Pct'],
                'sharpe': m['Sharpe_Ratio_365'],
                'profit_factor': m['Profit_Factor'],
                'exp_r': m['Esperanza_Matematica_R'],
                'win_rate': m['Win_Rate_Pct'],
                'ops': m['Total_Operaciones']
            })
    return results

print("Auditing BTC...")
btc_res = full_audit('c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/btc_4h.csv', 'c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/btc_1d.csv', 'BTC')

print("Auditing ETH...")
eth_res = full_audit('c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/eth_4h.csv', 'c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/eth_1d.csv', 'ETH')

with open('c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/full_doc_audit.json', 'w') as f:
    json.dump({'btc': btc_res, 'eth': eth_res}, f, indent=2)

print("\n=== AUDITORIA COMPLETA DE TODAS LAS ESTRATEGIAS DEL DOCUMENTO ===")
for r in btc_res + eth_res:
    sign = "+" if r['ret_pct'] >= 0 else ""
    print(f"{r['symbol']} | {r['strat']:<12} ({r['market']:<4}) -> $1,000 a ${r['final']:<7} ({sign}{r['ret_pct']}%) | CAGR: {r['cagr_pct']}% | PF: {r['profit_factor']:<4} | DD: {r['max_dd_pct']}% | WR: {r['win_rate']}% | Ops: {r['ops']}")
