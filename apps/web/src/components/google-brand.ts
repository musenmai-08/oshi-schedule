import type { SxProps, Theme } from '@mui/material/styles';

export const GOOGLE_BRANDED_BUTTON_SX: SxProps<Theme> = {
  minHeight: 40,
  minWidth: 210,
  px: 3,
  borderRadius: '4px',
  borderColor: '#747775',
  color: '#1f1f1f',
  backgroundColor: '#fff',
  textTransform: 'none',
  fontFamily: 'Roboto, Arial, sans-serif',
  fontSize: '14px',
  fontWeight: 500,
  letterSpacing: '0.25px',
  boxShadow: 'none',
  '&:hover': {
    backgroundColor: '#f8fafd',
    borderColor: '#747775',
    boxShadow: '0 1px 2px 0 rgba(60, 64, 67, 0.3)',
  },
};
