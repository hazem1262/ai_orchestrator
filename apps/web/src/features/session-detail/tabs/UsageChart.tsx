import type { UsagePoint } from '@orc/api-contract';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';
import { buildUsageOption, type UsageMetric } from './usage-option.ts';

echarts.use([LineChart, BarChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

export function UsageChart({ points, metric }: { points: readonly UsagePoint[]; metric: UsageMetric }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || points.length === 0) return;
    const chart = echarts.init(el, undefined, { renderer: 'canvas' });
    chart.setOption(buildUsageOption(points, metric));
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.dispose();
    };
  }, [points, metric]);

  return <div ref={ref} data-testid="usage-chart" className="h-[420px] w-full" />;
}
