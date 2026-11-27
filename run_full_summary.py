import sys
sys.path.append('c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch')
import runnable_doc_script as rds
import pandas as pd

def run_full(csv_4h, csv_1d, name, risk=0.015, strat='C5_COMBINED'):
    df_4h = rds.audit_ohlcv_continuity(pd.read_csv(csv_4h), expected_freq_hours=4)
    df_1d = rds.audit_ohlcv_continuity(pd.read_csv(csv_1d), expected_freq_hours=24)
    params = rds.StrategyParams(risk_per_trade=risk)
    merged = rds.prepare_multitimeframe_features(df_4h, df_1d, params)
    cost = rds.CostConfig('Perp_Base', 'perp', 0.0005, 0.0005, 0.0010, 0.00015, allow_shorts=True)
    eq_df, tr_df = rds.run_backtest(merged, strat, params, cost, initial_capital=1000.0)
    m = rds.compute_mandatory_metrics(eq_df, tr_df)
    final_eq = eq_df['equity'].iloc[-1]
    ret_pct = m['Rentabilidad_Neta_Acumulada_Pct']
    pf = m['Profit_Factor']
    dd = m['Maximo_Drawdown_Pct']
    ops = m['Total_Operaciones']
    print(f"{name} ({strat} | Riesgo {risk*100:.1f}%): $1,000 -> Final: ${final_eq:.2f} (+{ret_pct:.1f}%) | PF: {pf} | MaxDD: {dd}% | Ops: {ops}")

print("=== BENEFICIO TOTAL ACUMULADO ===")
run_full('c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/btc_4h.csv', 'c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/btc_1d.csv', 'BTC', 0.015, 'C5_COMBINED')
run_full('c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/eth_4h.csv', 'c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/eth_1d.csv', 'ETH', 0.015, 'C5_COMBINED')
run_full('c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/btc_4h.csv', 'c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/btc_1d.csv', 'BTC', 0.015, 'C6_BASELINE')
run_full('c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/eth_4h.csv', 'c:/Users/useru/.gemini/antigravity/brain/2bfd0a7f-bdae-4fb3-ad83-c9a65780fd06/scratch/eth_1d.csv', 'ETH', 0.015, 'C6_BASELINE')


